import { instancedArray } from 'three/tsl';
import * as THREE from 'three/webgpu';

import type { ColliderSet } from './colliders';
import type { GroomGroupData } from './groom/types';
import { HairUniforms, buildParticleProfile, type HairParamsData } from './params';
import { createGuideDebug } from './render/GuideDebug';
import type { HairLighting } from './render/HairLighting';
import {
  HairDepthMaterial,
  HairMaterial,
  STRANDS_PER_INSTANCE,
  createRibbonGeometry,
  hairRenderSettings,
} from './render/HairMaterial';
import type { HairShadowMap } from './render/HairShadowPass';
import type { GroupContext } from './sim/context';
import type { GrowthDeformer } from './sim/deform';
import { buildInterpolateKernel } from './sim/interpolate';
import { buildShadeKernel } from './sim/shade';
import { buildResetKernel, buildRootsKernel, buildSolveKernel } from './sim/solver';
import { tsl } from './sim/tsl';
import type { N } from './sim/tslUtil';

/** Frees GPU buffers (storage nodes' attributes) that nothing will use again; see HairSystem.releaseBuffers. */
export type ReleaseBuffers = (buffers: N[]) => void;

interface StaticBuffers {
  guideRootTri: N;
  guideRootBary: N;
  guideRest: N;
  strandData: N;
  /** Groups using these buffers; they are released when the last one is disposed. */
  users: number;
}

/**
 * Packs the four per-strand arrays into 4 uvec4 per strand: guide indices, guide weights, root triangle,
 * root barycentrics (floats stored as raw bits).
 */
function packStrands(st: GroomGroupData['strands']): Uint32Array {
  const out = new Uint32Array(st.count * 16);
  const f = new Float32Array(out.buffer);
  for (let i = 0; i < st.count; i++) {
    out.set(st.guides.subarray(i * 4, i * 4 + 4), i * 16);
    f.set(st.weights.subarray(i * 4, i * 4 + 4), i * 16 + 4);
    out.set(st.rootTri.subarray(i * 4, i * 4 + 4), i * 16 + 8);
    f.set(st.rootBary.subarray(i * 4, i * 4 + 4), i * 16 + 12);
  }
  return out;
}

/** Static groom buffers are shared between instances of the same groom (e.g. two foxes). */
const staticCache = new WeakMap<GroomGroupData, StaticBuffers>();

function getStatic(data: GroomGroupData): StaticBuffers {
  let s = staticCache.get(data);
  if (!s) {
    const g = data.guides;
    const st = data.strands;
    s = {
      guideRootTri: instancedArray(g.rootTri, 'uvec4').toReadOnly() as N,
      guideRootBary: instancedArray(g.rootBary, 'vec4').toReadOnly() as N,
      guideRest: instancedArray(g.rest, 'vec4').toReadOnly() as N,
      strandData: instancedArray(packStrands(st), 'uvec4').toReadOnly() as N,
      users: 0,
    };
    staticCache.set(data, s);
  }
  s.users++;
  return s;
}

function releaseStatic(data: GroomGroupData, release: ReleaseBuffers): void {
  const s = staticCache.get(data);
  if (!s || --s.users > 0) return;
  staticCache.delete(data);
  release([s.guideRootTri, s.guideRootBary, s.guideRest, s.strandData]);
}

export interface HairGroupOptions {
  params: HairParamsData;
  lighting: HairLighting;
  shadowMap: HairShadowMap;
  shadowLayer: number;
  release: ReleaseBuffers;
}

/** Fraction of drawn strands rendered into the hair shadow map (wider to compensate). */
export const SHADOW_STRAND_FRACTION = 0.35;
/** Shadow ribbons use every n-th strand point. */
export const SHADOW_POINT_STRIDE = 2;

/** GPU state, kernels and meshes for one groom group on one character. */
export class HairGroup {
  readonly name: string;
  readonly ctx: GroupContext;
  readonly uniforms = new HairUniforms();
  readonly params: HairParamsData;
  readonly mesh: THREE.Mesh;
  readonly shadowMesh: THREE.Mesh;
  material: HairMaterial;
  readonly depthMaterial: HairDepthMaterial;
  readonly guideLines: THREE.LineSegments;
  readonly kernels: { roots: N; reset: N; solve: N; interpolate: N; shade: N };
  readonly maxLength: number;
  private readonly profile: N;
  private readonly profileData: Float32Array;
  /** Strands currently simulated/drawn (≤ ctx.Ns). */
  activeStrands: number;
  needsReset = true;

  readonly data: GroomGroupData;

  constructor(
    data: GroomGroupData,
    deformer: GrowthDeformer,
    colliders: ColliderSet,
    opts: HairGroupOptions,
  ) {
    this.data = data;
    this.name = data.spec.name;
    this.params = opts.params;
    this.maxLength = data.maxLength;
    const G = data.guides.particles;
    const Ng = data.guides.count;
    const R = data.strands.points;
    const Ns = data.strands.count;
    this.release = opts.release;
    const st = getStatic(data);
    this.profileData = new Float32Array(G * 4);
    this.profile = instancedArray(this.profileData, 'vec4') as N;

    this.ctx = {
      G,
      Ng,
      R,
      Ns,
      interpSpace: data.spec.interpSpace,
      u: this.uniforms,
      colliders,
      view: { cameraPos: opts.lighting.cameraPos, frustumPlanes: opts.lighting.frustumPlanes },
      deformed: deformer.deformed,
      guideRootTri: st.guideRootTri,
      guideRootBary: st.guideRootBary,
      guideRest: st.guideRest,
      strandData: st.strandData,
      guidePos: instancedArray(data.guides.initWorld.slice(), 'vec4') as N,
      guidePrev: instancedArray(data.guides.initWorld.slice(), 'vec4') as N,
      guideFrames: instancedArray(Ng * 6, 'vec4') as N,
      profile: this.profile,
      renderPos: instancedArray(Ns * R, 'vec4') as N,
      renderColor: instancedArray(Ns * R, 'uvec4') as N,
      strandHidden: instancedArray(Ns, 'uint') as N,
      shadowHistory: instancedArray(new Float32Array(Ns * R * 2).fill(1), 'vec2') as N,
    };

    this.kernels = {
      roots: buildRootsKernel(this.ctx),
      reset: buildResetKernel(this.ctx),
      solve: buildSolveKernel(this.ctx),
      interpolate: buildInterpolateKernel(this.ctx),
      shade: buildShadeKernel(this.ctx, opts.lighting, opts.shadowMap),
    };

    this.material = this.createMaterial();
    this.mesh = new THREE.Mesh(this.ribbonGeometry(1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = `hair:${this.name}`;
    this.mesh.renderOrder = 1;

    this.depthMaterial = new HairDepthMaterial(R, this.ctx.renderPos, SHADOW_POINT_STRIDE);
    this.shadowMesh = new THREE.Mesh(
      createRibbonGeometry(Math.ceil((R - 1) / SHADOW_POINT_STRIDE) + 1),
      this.depthMaterial,
    );
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.layers.set(opts.shadowLayer);
    this.shadowMesh.name = `hair-shadow:${this.name}`;

    this.guideLines = createGuideDebug(this.ctx.guidePos, Ng, G);
    this.guideLines.visible = false;

    this.activeStrands = Ns;
    this.setActiveStrands(Ns);
    this.syncParams();
  }

  /** Ribbon templates by draw stride (draw LOD), built on first use. */
  private readonly ribbons = new Map<number, THREE.BufferGeometry>();
  /** Every n-th strand point is drawn (see HairSystem's draw LOD). */
  drawStride = 1;

  /** Points drawn per strand at a draw stride: every stride-th point and always the tip. */
  drawnPoints(stride = this.drawStride): number {
    return Math.ceil((this.ctx.R - 1) / stride) + 1;
  }

  private ribbonGeometry(stride: number): THREE.BufferGeometry {
    let g = this.ribbons.get(stride);
    if (!g) {
      g = createRibbonGeometry(this.drawnPoints(stride));
      this.ribbons.set(stride, g);
    }
    return g;
  }

  setDrawStride(stride: number): void {
    if (stride === this.drawStride) return;
    this.drawStride = stride;
    this.uniforms.drawStride.value = stride;
    this.mesh.geometry = this.ribbonGeometry(stride);
  }

  /** Last frame's strand points and the kernel that saves them (allocated when TAA is first used). */
  private prevRenderPos: N = null;
  copyKernel: N = null;

  private readonly release: ReleaseBuffers;

  /** Recreates the strand material (e.g. after changing the coverage technique). */
  rebuildMaterial(): void {
    const old = this.material;
    this.material = this.createMaterial();
    this.mesh.material = this.material;
    old.dispose();
  }

  /** Strand material for the current coverage technique (TAA also needs last frame's points). */
  private createMaterial(): HairMaterial {
    if (hairRenderSettings.coverage === 'temporal' && !this.prevRenderPos) {
      const { Fn, instanceIndex } = tsl;
      const { Ns, R, renderPos } = this.ctx;
      const prev = (this.prevRenderPos = instancedArray(Ns * R, 'vec4') as N);
      this.copyKernel = (
        Fn(() => {
          prev.element(instanceIndex).assign(renderPos.element(instanceIndex));
        }) as N
      )()
        .compute(Ns * R, [64])
        .setName('hair.savePrevious');
      this.copyKernel.count = (this.activeStrands ?? Ns) * R;
    }
    return new HairMaterial({
      R: this.ctx.R,
      renderPos: this.ctx.renderPos,
      renderColor: this.ctx.renderColor,
      u: this.uniforms,
      prevRenderPos: this.prevRenderPos,
    });
  }

  /** Copies GUI params into uniforms and the per-particle profile buffer. */
  syncParams(): void {
    this.uniforms.sync(this.params);
    buildParticleProfile(this.params.physics, this.ctx.G, this.profileData);
    const attr = (this.profile as { value: THREE.BufferAttribute }).value;
    (attr.array as Float32Array).set(this.profileData);
    attr.needsUpdate = true;
  }

  setActiveStrands(n: number): void {
    const count = Math.max(1, Math.min(this.ctx.Ns, Math.round(n)));
    this.activeStrands = count;
    this.kernels.interpolate.count = count;
    this.kernels.shade.count = count * this.ctx.R;
    if (this.copyKernel) this.copyKernel.count = count * this.ctx.R;
    this.uniforms.strandCount.value = count;
    this.mesh.count = Math.ceil(count / STRANDS_PER_INSTANCE);
    const shadowCount = Math.max(1, Math.round(count * SHADOW_STRAND_FRACTION));
    this.depthMaterial.strandCount.value = shadowCount;
    this.uniforms.shadowStrandCount.value = shadowCount;
    this.shadowMesh.count = Math.ceil(shadowCount / STRANDS_PER_INSTANCE);
    this.depthMaterial.widthScale.value = Math.min(
      4,
      Math.sqrt(count / shadowCount) * (this.uniforms.widthScale.value as number),
    );
  }

  /** Frees the meshes, compute pipelines and GPU buffers (the group can't be used afterwards). */
  dispose(): void {
    for (const g of this.ribbons.values()) g.dispose();
    this.shadowMesh.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.guideLines.geometry.dispose();
    (this.guideLines.material as THREE.Material).dispose();
    for (const k of [...Object.values(this.kernels), this.copyKernel]) k?.dispose();
    const c = this.ctx;
    this.release(
      [
        c.guidePos,
        c.guidePrev,
        c.guideFrames,
        c.profile,
        c.renderPos,
        c.renderColor,
        c.strandHidden,
        c.shadowHistory,
        this.prevRenderPos,
      ].filter((b) => b !== null),
    );
    releaseStatic(this.data, this.release);
  }
}
