import * as THREE from 'three/webgpu';

import type { LightRig } from '../app/LightRig';
import type { HairGroup } from './HairGroup';
import { HairInstance, type HairInstanceOptions } from './HairInstance';
import { HairLighting } from './render/HairLighting';
import { hairFrame, hairRenderSettings, type CoverageMode } from './render/HairMaterial';
import {
  HAIR_SHADOW_LAYER,
  HairShadowMap,
  OPAQUE_SHADOW_LAYER,
  setReceivedShadow,
} from './render/HairShadowPass';
import { tsl } from './sim/tsl';
import type { N } from './sim/tslUtil';

const { Fn, positionWorld } = tsl;

export interface HairStats {
  instances: number;
  groups: number;
  guides: number;
  guideParticles: number;
  strandsActive: number;
  strandsTotal: number;
  vertices: number;
}

const MAX_INSTANCES = 4;
const tmpSphere = new THREE.Sphere();
const tmpVec = new THREE.Vector3();
const white = new THREE.Color(1, 1, 1);

/** Largest draw stride tried by the draw LOD. */
const MAX_DRAW_STRIDE = 4;
/** A coarser stride is only taken once its segments are this much shorter than the limit (no flicker at the edge). */
const STRIDE_HYSTERESIS = 0.85;

/**
 * Draw LOD stride for a group at `pxPerMeter` on screen: the largest stride whose segments (of the longest
 * strand) stay within `lodSegmentPx`, keeping at least 3 segments and, for a visible curl, 8 points per turn.
 */
function drawStrideFor(g: HairGroup, pxPerMeter: number): number {
  const st = g.params.style;
  const limit = st.lodSegmentPx;
  if (!(limit > 0)) return 1;
  const segments = g.ctx.R - 1;
  const segmentPx = (g.maxLength / segments) * pxPerMeter;
  const minPointsPerTurn = st.curlRadius * pxPerMeter > 0.5 ? 8 : 0;
  let stride = 1;
  for (let s = 2; s <= MAX_DRAW_STRIDE; s++) {
    // Stay at the current stride or finer at the edge of the limit; only go coarser with some margin.
    const margin = s > g.drawStride ? STRIDE_HYSTERESIS : 1;
    if (segmentPx * s > limit * margin) break;
    if (segments / s < 3) break;
    if (minPointsPerTurn && segments / s / Math.max(st.curlTurns, 1e-3) < minPointsPerTurn) break;
    stride = s;
  }
  return stride;
}

/**
 * Orchestrates the per-frame GPU work for every hair instance:
 * deform → roots → (reset) → solve (substeps in-kernel) → (TAA: save previous) → interpolate →
 * hair shadow maps → shade. Each compute stage is one batched `renderer.compute([...])` call.
 */
export class HairSystem {
  readonly instances: HairInstance[] = [];
  readonly lighting: HairLighting;
  paused = false;
  stepOnce = false;
  lodEnabledGlobal = true;
  /** Global multiplier on drawn strand density. */
  densityScale = 1;
  shadowResolution = 2048;
  /** Multiplier on self-shadow density for hair shadows cast onto bodies / floor. */
  bodyShadowScale = 0.35;
  /** Profiling only (`__fursim.profile()`): stages to skip, so their cost shows up as a frame-time difference. */
  readonly debugSkip = { solve: false, interpolate: false, shadows: false, shade: false, draw: false };
  private readonly usedSlots = new Set<number>();
  private readonly slotOf = new Map<HairInstance, number>();
  private readonly opaqueDepthMaterial = new THREE.MeshBasicNodeMaterial({ colorWrite: false });
  private readonly float32Blendable: boolean;

  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly lights: LightRig;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    lights: LightRig,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.lights = lights;
    this.lighting = new HairLighting(scene.environment);
    this.float32Blendable = renderer.hasFeature('float32-blendable');
  }

  /**
   * Destroys the GPU buffers behind storage nodes nobody uses any more (regroomed or removed hair). three.js
   * only frees storage buffers through geometry disposal, so this goes through the renderer's attribute
   * manager (internal API; it ignores buffers that were never uploaded or are already freed).
   */
  private readonly releaseBuffers = (buffers: N[]): void => {
    const attributes = (this.renderer as unknown as { _attributes?: { delete(a: unknown): unknown } | null })
      ._attributes;
    if (!attributes) return;
    for (const b of buffers) {
      const attr = (b as { value?: unknown }).value;
      if (attr) attributes.delete(attr);
    }
  };

  /** Creates a hair instance wired to the shared lighting and a dedicated shadow map. */
  createInstance(opts: HairInstanceOptions): HairInstance {
    let slot = 0;
    while (this.usedSlots.has(slot) && slot < MAX_INSTANCES) slot++;
    if (slot >= MAX_INSTANCES) throw new Error(`At most ${MAX_INSTANCES} hair instances are supported`);
    this.usedSlots.add(slot);
    const shadowMap = new HairShadowMap(
      opts.shadowResolution ?? this.shadowResolution,
      this.float32Blendable,
    );
    const inst = new HairInstance(opts, {
      lighting: this.lighting,
      shadowMap,
      shadowLayer: HAIR_SHADOW_LAYER + slot,
      release: this.releaseBuffers,
    });
    this.slotOf.set(inst, slot);
    this.instances.push(inst);
    this.scene.add(inst.root);
    this.refreshReceivers();
    return inst;
  }

  remove(instance: HairInstance): void {
    const i = this.instances.indexOf(instance);
    if (i >= 0) this.instances.splice(i, 1);
    const slot = this.slotOf.get(instance);
    if (slot !== undefined) this.usedSlots.delete(slot);
    this.slotOf.delete(instance);
    instance.shadowMap.dispose();
    instance.dispose();
    this.refreshReceivers();
  }

  get groups(): HairGroup[] {
    return this.instances.flatMap((i) => i.groups);
  }

  update(dt: number, time: number): void {
    if (this.instances.length === 0) return;
    const simulate = !this.paused || this.stepOnce;
    const simDt = this.paused ? 1 / 60 : dt;
    this.stepOnce = false;
    this.lighting.sync(this.lights, this.camera, this.scene);
    const keyDir = this.lighting.key.dir.value as THREE.Vector3;

    const deform: N[] = [];
    const roots: N[] = [];
    const resets: N[] = [];
    const solves: N[] = [];
    const interps: N[] = [];
    const shades: N[] = [];
    for (const inst of this.instances) {
      inst.deformer.prepare();
      inst.colliders.update(inst.needsReset);
      deform.push(inst.deformer.kernel);
      const skinnedSdf = inst.colliders.sdfSkin;
      if (skinnedSdf) {
        skinnedSdf.prepare();
        deform.push(...skinnedSdf.kernels);
      }
      inst.getBoundingSphere(tmpSphere);
      inst.shadowMap.fit(keyDir, tmpSphere.center, tmpSphere.radius);
      // Hair shadows on skin use a lighter density than strand-on-strand self-shadowing (softer, less inky).
      if (inst.groups[0])
        inst.bodyShadowDensity.value = inst.groups[0].params.shading.selfShadowDensity * this.bodyShadowScale;
      for (const g of inst.groups) {
        if (inst.needsReset) g.needsReset = true;
        g.uniforms.firstFrame.value = g.needsReset ? 1 : 0;
        g.uniforms.syncFrame(simDt, time);
        roots.push(g.kernels.roots);
        if (g.needsReset) resets.push(g.kernels.reset);
        solves.push(g.kernels.solve);
        interps.push(g.kernels.interpolate);
        shades.push(g.kernels.shade);
        this.updateLod(inst, g);
      }
      inst.needsReset = false;
    }

    const r = this.renderer;
    const skip = this.debugSkip;
    for (const inst of this.instances)
      for (const g of inst.groups) g.mesh.visible = inst.showStrands && !skip.draw;
    void r.compute(deform);
    // Roots run even while paused, so the root frames never go stale and unpausing doesn't jump.
    void r.compute(roots);
    if (resets.length) void r.compute(resets);
    if (simulate && !skip.solve) void r.compute(solves);
    if (hairRenderSettings.coverage === 'temporal') {
      // TAA: save last frame's strand points (before interpolate overwrites them) for motion vectors,
      // and vary the coverage noise.
      const copies = this.groups.map((g) => g.copyKernel).filter((k): k is N => k !== null);
      if (copies.length) void r.compute(copies);
      (hairFrame.value as number) = ((hairFrame.value as number) + 1) % 65536;
    }
    if (!skip.interpolate) void r.compute(interps);
    if (!skip.shadows) this.renderShadowMaps();
    if (!skip.shade) void r.compute(shades);
    for (const g of this.groups) g.needsReset = false;
  }

  /** Renders each instance's opaque-caster depth and hair front/back depth from the key light. */
  private renderShadowMaps(): void {
    const r = this.renderer;
    const scene = this.scene;
    const savedBg = scene.background;
    const savedBgNode = scene.backgroundNode;
    const savedOverride = scene.overrideMaterial;
    const savedAutoClear = r.autoClear;
    const savedTarget = r.getRenderTarget();
    const savedClear = r.getClearColor(new THREE.Color());
    const savedAlpha = r.getClearAlpha();
    scene.background = null;
    scene.backgroundNode = null;
    r.autoClear = false;
    for (const inst of this.instances) {
      const map = inst.shadowMap;
      const cam = map.camera;
      // Opaque casters (bodies) → depth.
      cam.layers.set(OPAQUE_SHADOW_LAYER);
      scene.overrideMaterial = this.opaqueDepthMaterial;
      r.setRenderTarget(map.opaqueTarget);
      r.clear(true, true, false);
      r.render(scene, cam);
      // Hair → (front, −back) with MIN blending. Clearing to white means no hair: front at the far
      // plane and back at −1, so the thickness is 0.
      scene.overrideMaterial = null;
      cam.layers.set(inst.shadowLayer);
      r.setRenderTarget(map.hairTarget);
      r.setClearColor(white, 1);
      r.clear(true, false, false);
      r.render(scene, cam);
      r.setClearColor(savedClear, savedAlpha);
    }
    scene.overrideMaterial = savedOverride;
    scene.background = savedBg;
    scene.backgroundNode = savedBgNode;
    r.autoClear = savedAutoClear;
    r.setRenderTarget(savedTarget);
  }

  /**
   * Thins strands while they are thinner than a pixel (`lodSubpixelDensity`) or denser on screen than
   * `lodStrandsPerPixel`, with width compensation, and draws fewer points per strand while the segments stay
   * shorter on screen than `lodSegmentPx`.
   */
  private updateLod(inst: HairInstance, g: HairGroup): void {
    const st = g.params.style;
    const total = g.ctx.Ns;
    let fraction = Math.min(1, Math.max(0.01, st.density * this.densityScale));
    let widthScale = 1;
    let stride = 1;
    if (st.lodEnabled && this.lodEnabledGlobal) {
      inst.getBoundingSphere(tmpSphere);
      const dist = Math.max(
        0.05,
        tmpVec.copy(tmpSphere.center).distanceTo(this.camera.position) - tmpSphere.radius * 0.5,
      );
      const viewportH = this.renderer.domElement.height;
      const pxPerMeter = viewportH / (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
      // Sub-pixel strands are drawn minPixelWidth wide with coverage = width / minPixelWidth, so f of them at 1/f
      // the width cover the same on average, as long as they stay sub-pixel (f ≥ width / minPixelWidth).
      const widthPx = st.rootWidth * pxPerMeter;
      const minPx = Math.max(st.minPixelWidth, 1e-3);
      if (st.lodSubpixelDensity < 1 && widthPx < minPx) {
        const f = Math.max(st.lodSubpixelDensity, widthPx / minPx);
        fraction *= f;
        widthScale /= f;
      }
      const radiusPx = tmpSphere.radius * pxPerMeter;
      const areaPx = Math.max(1, Math.PI * radiusPx * radiusPx * 0.5);
      const strandsPerPixel = (total * fraction) / areaPx;
      if (strandsPerPixel > st.lodStrandsPerPixel) {
        const f = st.lodStrandsPerPixel / strandsPerPixel;
        fraction *= f;
        widthScale *= Math.pow(1 / Math.max(f, 1e-3), st.lodWidthExponent);
      }
      stride = drawStrideFor(g, pxPerMeter);
    }
    const active = Math.max(64, Math.round(total * Math.min(1, fraction)));
    g.uniforms.widthScale.value = Math.min(widthScale, 6);
    g.setActiveStrands(active);
    g.setDrawStride(stride);
    // Fade out the last 8% of drawn strands so LOD changes don't pop.
    g.uniforms.lodFadeStart.value = active < total ? Math.floor(active * 0.92) : total + 1;
    g.uniforms.lodFadeEnd.value = active < total ? active : total + 2;
  }

  stats(): HairStats {
    const s: HairStats = {
      instances: this.instances.length,
      groups: 0,
      guides: 0,
      guideParticles: 0,
      strandsActive: 0,
      strandsTotal: 0,
      vertices: 0,
    };
    for (const g of this.groups) {
      s.groups++;
      s.guides += g.ctx.Ng;
      s.guideParticles += g.ctx.Ng * g.ctx.G;
      s.strandsActive += g.activeStrands;
      s.strandsTotal += g.ctx.Ns;
      s.vertices += g.activeStrands * g.drawnPoints() * 2;
    }
    return s;
  }

  /** Materials (e.g. the floor) that receive hair shadows from every instance. */
  private readonly receivers = new Set<THREE.NodeMaterial>();

  registerShadowReceiver(material: THREE.NodeMaterial): void {
    this.receivers.add(material);
    this.applyHairShadowsTo(material);
  }

  private refreshReceivers(): void {
    for (const m of this.receivers) this.applyHairShadowsTo(m);
  }

  /** Multiplies a material's received key-light shadow by the hair transmittance of all instances. */
  applyHairShadowsTo(material: THREE.NodeMaterial): void {
    const maps = this.instances.map((i) => ({ map: i.shadowMap, density: i.bodyShadowDensity }));
    setReceivedShadow(
      material,
      Fn(([shadow]: [N]) => {
        let s: N = shadow;
        for (const m of maps) s = s.mul(m.map.transmittanceSmooth(positionWorld, m.density));
        return s;
      }),
    );
  }

  /** Switches the strand coverage technique for every group. */
  setCoverage(mode: CoverageMode): void {
    hairRenderSettings.coverage = mode;
    for (const g of this.groups) g.rebuildMaterial();
  }

  /** MSAA coverage technique to return to when TAA is switched off. */
  private msaaCoverage: CoverageMode = hairRenderSettings.coverage;

  /** TAA renders hair with temporal (per-pixel, per-frame) coverage and motion vectors; MSAA restores the previous technique. */
  setTemporalAntialiasing(on: boolean): void {
    if (on === (hairRenderSettings.coverage === 'temporal')) return;
    if (on) this.msaaCoverage = hairRenderSettings.coverage;
    this.setCoverage(on ? 'temporal' : this.msaaCoverage);
  }

  resetAll(): void {
    for (const i of this.instances) i.reset();
  }
}
