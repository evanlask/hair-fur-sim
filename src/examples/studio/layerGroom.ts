import * as THREE from 'three/webgpu';

import type { QualityPreset } from '../../app/quality';
import { SpatialHash } from '../../hair/groom/SpatialHash';
import { createPaintedStyle } from '../../hair/groom/styles/paintedStyle';
import type { GroomGroupData } from '../../hair/groom/types';
import type { HairInstance } from '../../hair/HairInstance';
import type { HairSystem } from '../../hair/HairSystem';
import type { HairParamsData } from '../../hair/params';
import { applyHairShadow } from '../../hair/render/HairShadowPass';
import { gatherSteer } from './gather';
import { paintedArea, paintedLayer, type Layer } from './layers';
import type { StudioBust } from './StudioBust';

/** Drawn strands across all layers above which the HUD warns (× the quality preset's strand scale). */
export const STRAND_BUDGET = 150_000;

/**
 * Keeps one hair instance in step with the layers: a layer is a hair group grown from its painted maps. Changes to
 * where hair grows (density, settings, layers added or removed) regrow just those groups: groomed on the CPU, their
 * shaders compiled in the background while the old hair keeps drawing, then swapped in. Shape edits (length, comb,
 * lift, curve, wave) regrow the guides in place every frame, near the brush only.
 */
export class LayerGroom {
  readonly layers: Layer[] = [];
  instance: HairInstance | null = null;
  /** Shared with the instance (groups find their params by layer id) and the GUI. */
  readonly paramObjects: Record<string, HairParamsData> = {};
  /** Last regrow (CPU groom) and compile times and the last reshape time (ms). */
  readonly timings = { regrow: 0, compile: 0, reshape: 0 };
  /** Called after groups were swapped in (counts changed). */
  onRegrown: (() => void) | null = null;
  private readonly regrowIds = new Set<string>();
  /** Reshapes deferred the hair bounds: refresh them once the reshapes stop. */
  private boundsStale = false;
  /** Guides to reshape per layer id: indices, or null for all. */
  private readonly reshapes = new Map<string, Set<number> | null>();
  private regrowing = false;
  /** Bumped by rebuildAll, so a regrow that was compiling meanwhile knows its groups are stale. */
  private generation = 0;
  /** Bumped by every shape edit, so a regrow that ran meanwhile knows its guides are stale. */
  private readonly shapeVersion = new Map<string, number>();
  private readonly areas = new Map<string, number>();
  private readonly guideHashes = new WeakMap<GroomGroupData, SpatialHash>();

  private readonly bust: StudioBust;
  private readonly hair: HairSystem;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly camera: THREE.Camera;
  private readonly scene: THREE.Scene;
  private readonly quality: QualityPreset;

  constructor(
    bust: StudioBust,
    hair: HairSystem,
    view: { renderer: THREE.WebGPURenderer; camera: THREE.Camera; scene: THREE.Scene },
    quality: QualityPreset,
  ) {
    this.bust = bust;
    this.hair = hair;
    this.renderer = view.renderer;
    this.camera = view.camera;
    this.scene = view.scene;
    this.quality = quality;
  }

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  /** Painted area of a layer (m²), cached until its density changes (see `densityChanged`). */
  area(layer: Layer): number {
    let a = this.areas.get(layer.id);
    if (a === undefined) {
      a = paintedArea(this.bust.growth, this.bust.paint.weld, layer.fields.density, this.bust.bare);
      this.areas.set(layer.id, a);
    }
    return a;
  }

  /** The painted style of the layers that have hair painted (hidden ones too: hiding just disables their group). */
  private style() {
    const painted = this.layers.flatMap((l) => {
      const p = paintedLayer(l, this.area(l));
      if (!p) return [];
      const at = l.settings.gather;
      if (at)
        p.steer = gatherSteer(
          this.bust.paint,
          new THREE.Vector3(...at),
          this.homeModelMatrix,
          this.bust.head.scale,
        );
      return [p];
    });
    return createPaintedStyle({
      layers: painted,
      indices: this.bust.growth.indices,
      fieldIndex: this.bust.paint.weld,
      fieldToWorld: this.bust.modelToWorld,
      bare: this.bust.bare,
    });
  }

  /** Grows every layer (first build, or after replacing all layers). */
  rebuildAll(): void {
    for (const l of this.layers) this.paramObjects[l.id] = l.params;
    this.areas.clear();
    const style = this.style();
    const groom = {
      seed: 11,
      strandScale: this.quality.strandScale,
      guideScale: this.quality.guideScale,
      collisionMargin: 0.003,
      keepRoots: true,
    };
    this.bust.withHomePose(() => {
      if (this.instance) {
        this.instance.setStyle(style);
        this.instance.build(groom);
      } else {
        this.instance = this.hair.createInstance({
          name: 'studio',
          source: this.bust.source,
          growth: this.bust.growth,
          style,
          colliders: this.bust.colliders,
          paramObjects: this.paramObjects,
          groom,
          boundsObject: this.bust.model,
        });
        applyHairShadow(this.bust.material, this.instance.shadowMap, this.instance.bodyShadowDensity);
      }
    });
    this.generation++;
    this.regrowIds.clear();
    this.reshapes.clear();
    this.applyVisibility();
    this.onRegrown?.();
  }

  /** Shows the groups of visible layers (only the soloed one, if any) and turns the others off. */
  applyVisibility(solo: string | null = this.solo): void {
    this.solo = solo;
    for (const g of this.instance?.groups ?? []) {
      const layer = this.layer(g.name);
      g.setEnabled(solo ? g.name === solo : (layer?.visible ?? true));
    }
    this.instance?.setVisibility(this.instance.showStrands, this.instance.showGuides);
  }
  private solo: string | null = null;

  /** Where a layer's hair grows changed (density, settings, added, removed or shown / hidden). */
  densityChanged(id: string): void {
    this.areas.delete(id);
    this.regrowIds.add(id);
  }

  /** A layer's shape maps changed near `points` (model space, within `radius` m), or everywhere. */
  shapeChanged(id: string, points?: THREE.Vector3[], radius = 0): void {
    this.shapeVersion.set(id, (this.shapeVersion.get(id) ?? 0) + 1);
    const group = this.instance?.groups.find((g) => g.name === id);
    if (!group) return;
    if (!points || this.reshapes.get(id) === null) {
      this.reshapes.set(id, null);
      return;
    }
    const subset = this.reshapes.get(id) ?? new Set<number>();
    const hash = this.guideHash(group.data);
    const p = new THREE.Vector3();
    // Guides whose root triangle has a touched vertex: within the radius plus a triangle or so.
    const reach = radius + 0.02;
    const ring = Math.ceil(reach / hash.cellSize);
    for (const q of points) {
      p.copy(q).applyMatrix4(this.homeModelMatrix);
      hash.forEachNear(p.x, p.y, p.z, ring, (gi, d2) => {
        if (d2 <= reach * reach) subset.add(gi);
      });
    }
    this.reshapes.set(id, subset);
  }

  /** Model → world in the home pose (the space the growth mesh and guide roots are in). */
  private get homeModelMatrix(): THREE.Matrix4 {
    return (this.homeMatrix ??= this.bust.withHomePose(() => this.bust.model.matrixWorld.clone()));
  }
  private homeMatrix: THREE.Matrix4 | null = null;

  private guideHash(data: GroomGroupData): SpatialHash {
    let h = this.guideHashes.get(data);
    if (!h) {
      h = new SpatialHash(0.02, data.guides.count);
      for (const r of data.guideRoots ?? []) h.insert(r.position.x, r.position.y, r.position.z);
      this.guideHashes.set(data, h);
    }
    return h;
  }

  /** Per frame: applies pending reshapes and starts a regrow if one is due and none is running. */
  update(): void {
    const inst = this.instance;
    if (!inst) return;
    if (this.reshapes.size) {
      const t0 = performance.now();
      this.bust.withHomePose(() => {
        for (const [id, subset] of this.reshapes)
          inst.reshapeGroup(id, subset ? [...subset] : undefined, true);
      });
      this.reshapes.clear();
      this.boundsStale = true;
      this.timings.reshape = performance.now() - t0;
    } else if (this.boundsStale) {
      this.boundsStale = false;
      this.bust.withHomePose(() => inst.refreshBounds());
    }
    if (this.regrowIds.size && !this.regrowing) void this.regrow();
  }

  /** True while a regrow is grooming or compiling. */
  get busy(): boolean {
    return this.regrowing || this.regrowIds.size > 0;
  }

  private async regrow(): Promise<void> {
    const inst = this.instance!;
    this.regrowing = true;
    try {
      while (this.regrowIds.size) {
        const ids = [...this.regrowIds];
        this.regrowIds.clear();
        for (const l of this.layers) this.paramObjects[l.id] = l.params;
        const versions = new Map(ids.map((id) => [id, this.shapeVersion.get(id) ?? 0]));
        const generation = this.generation;
        inst.setStyle(this.style());
        const t0 = performance.now();
        const pending = this.bust.withHomePose(() => inst.prepareGroups(ids));
        const t1 = performance.now();
        // Compile the new groups while the old ones keep drawing (a synchronous first use stalls ~80 ms).
        const groups = [...pending.built.values()];
        try {
          const kernels = groups.flatMap((g) => Object.values(g.kernels));
          if (kernels.length) await this.renderer.compileComputeAsync(kernels);
          for (const g of groups) await this.renderer.compileAsync(g.mesh, this.camera, this.scene);
        } catch (err) {
          // The old groups keep drawing; the layers regrow on their next edit.
          inst.discardGroups(pending);
          console.error('Groom Studio: regrow failed', err);
          continue;
        }
        // rebuildAll replaced every group meanwhile: these were built for the old style.
        if (generation !== this.generation || inst !== this.instance) {
          inst.discardGroups(pending);
          continue;
        }
        // (In the home pose, like the reshapes: the bounds are taken relative to the bust.)
        this.bust.withHomePose(() => inst.commitGroups(pending));
        this.applyVisibility();
        this.timings.regrow = t1 - t0;
        this.timings.compile = performance.now() - t1;
        // Shape edits that came in while compiling were made on the old guides: bring the new ones up to date.
        for (const id of pending.built.keys())
          if ((this.shapeVersion.get(id) ?? 0) !== (versions.get(id) ?? 0)) this.reshapes.set(id, null);
        this.onRegrown?.();
      }
    } finally {
      this.regrowing = false;
    }
  }

  /** Total strands the layers grow (before LOD), and the budget for this quality preset. */
  strandTotals(): { strands: number; budget: number } {
    const strands = (this.instance?.groups ?? []).reduce((n, g) => n + (g.enabled ? g.ctx.Ns : 0), 0);
    return { strands, budget: Math.round(STRAND_BUDGET * this.quality.strandScale) };
  }
}
