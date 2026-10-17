import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { ColliderSet } from './colliders';
import {
  buildGroom,
  buildGroomGroup,
  groomBounds,
  reshapeGroomGroup,
  type GroomOptions,
} from './groom/Groomer';
import { SurfaceSampler } from './groom/SurfaceSampler';
import type { GroomData, GroomGroupData, GroomStyle, GrowthMesh } from './groom/types';
import { HairGroup, type ReleaseBuffers } from './HairGroup';
import { mergeHairParams, type DeepPartial, type HairParamsData } from './params';
import type { HairLighting } from './render/HairLighting';
import type { HairShadowMap } from './render/HairShadowPass';
import { GrowthDeformer, type DeformSource } from './sim/deform';

export interface HairInstanceOptions {
  name: string;
  source: DeformSource;
  /** Growth mesh in bind-pose world space (see bindPoseWorldPositions). */
  growth: GrowthMesh;
  style: GroomStyle;
  colliders?: ColliderSet;
  /** Per-group parameter overrides (by group name), merged over defaults. */
  params?: Record<string, DeepPartial<HairParamsData>>;
  /** Per-group parameter objects used directly (shared with a GUI), takes precedence. */
  paramObjects?: Record<string, HairParamsData>;
  groom?: GroomOptions;
  /** Object whose world transform moves the hair bounds (root bone / object). */
  boundsObject?: THREE.Object3D;
  /** Hair shadow map size (px); defaults to HairSystem.shadowResolution. Large grooms (a field) need more. */
  shadowResolution?: number;
  /**
   * Draw, shade and shadow only the strands that survive culling and the view LOD (see StrandCompaction), for
   * grooms where most strands are culled at any time (a field). Off by default.
   */
  compactStrands?: boolean;
}

/** Injected by HairSystem.createInstance. */
export interface HairInstanceServices {
  lighting: HairLighting;
  shadowMap: HairShadowMap;
  shadowLayer: number;
  /** Frees GPU buffers of disposed groups (and the deformer). */
  release: ReleaseBuffers;
}

/** Groups built by `HairInstance.prepareGroups`, not yet swapped in. */
export interface PendingGroups {
  /** The style's group names (in order) when they were built. */
  names: string[];
  built: Map<string, HairGroup>;
}

/** One character's hair: growth-mesh deformer, colliders, shadow map and its groom groups. */
export class HairInstance {
  readonly name: string;
  readonly root = new THREE.Group();
  readonly deformer: GrowthDeformer;
  readonly colliders: ColliderSet;
  readonly shadowMap: HairShadowMap;
  readonly shadowLayer: number;
  groups: HairGroup[] = [];
  groom!: GroomData;
  needsReset = true;
  showGuides = false;
  showStrands = true;
  /** False shows the groomed (rest) shape: HairSystem resets the guides every frame instead of simulating them. */
  simulate = true;
  private sampler: SurfaceSampler | null = null;
  private readonly opts: HairInstanceOptions;
  private readonly services: HairInstanceServices;
  private readonly bindBoundsLocal = new THREE.Sphere();
  private bindScale = 1;

  constructor(opts: HairInstanceOptions, services: HairInstanceServices) {
    this.opts = opts;
    this.services = services;
    this.name = opts.name;
    this.shadowMap = services.shadowMap;
    this.shadowLayer = services.shadowLayer;
    this.root.name = `hair-instance:${opts.name}`;
    this.deformer = new GrowthDeformer(opts.source);
    this.colliders = opts.colliders ?? new ColliderSet();
    this.colliders.update(true);
    this.build(opts.groom ?? {});
  }

  get style(): GroomStyle {
    return this.opts.style;
  }

  /** Replaces the groom style (call build() afterwards). */
  setStyle(style: GroomStyle): void {
    this.opts.style = style;
  }

  /** (Re)grooms and recreates all GPU groups. Per-group params are preserved by name. */
  build(groomOptions: GroomOptions = {}): void {
    const previous = new Map(this.groups.map((g) => [g.name, g.params]));
    for (const g of this.groups) this.removeGroup(g);
    this.opts.groom = { ...this.opts.groom, ...groomOptions };
    this.colliders.update(true);
    this.groom = buildGroom(this.opts.growth, this.opts.style, {
      colliders: this.colliders,
      ...this.opts.groom,
    });
    this.groups = this.groom.groups.map((data) => {
      const group = this.createGroup(data, previous.get(data.spec.name));
      this.root.add(group.mesh, group.shadowMesh, group.guideLines);
      return group;
    });
    this.updateBounds();
    this.setVisibility(this.showStrands, this.showGuides);
    this.needsReset = true;
  }

  /**
   * Regrooms only the groups named in `names` and creates the style's new groups, without touching the ones in use:
   * swap them in with `commitGroups` (compile them first, e.g. with `renderer.compileComputeAsync`, and the old ones
   * keep drawing meanwhile) or drop them with `discardGroups`. Must run in the pose the growth mesh was taken in,
   * like build(); unlike build() it leaves the colliders' history and the other groups' simulation alone.
   */
  prepareGroups(names: Iterable<string>): PendingGroups {
    const want = new Set(names);
    const style = this.opts.style;
    const sampler = (this.sampler ??= new SurfaceSampler(this.opts.growth));
    const opts = { colliders: this.colliders, ...this.opts.groom };
    const built = new Map<string, HairGroup>();
    style.groups.forEach((spec, index) => {
      const old = this.groups.find((g) => g.name === spec.name);
      if (old && !want.has(spec.name)) return;
      const data = buildGroomGroup(this.opts.growth, sampler, style, spec, index, opts);
      built.set(spec.name, this.createGroup(data, old?.params));
    });
    return { names: style.groups.map((s) => s.name), built };
  }

  /** Swaps prepared groups in, in style order, and removes groups the style no longer has. */
  commitGroups(pending: PendingGroups): void {
    const next = pending.names
      .map((name) => pending.built.get(name) ?? this.groups.find((g) => g.name === name))
      .filter((g): g is HairGroup => g !== undefined);
    for (const g of this.groups) if (!next.includes(g)) this.removeGroup(g);
    for (const g of pending.built.values()) this.root.add(g.mesh, g.shadowMesh, g.guideLines);
    this.groups = next;
    this.refreshGroom();
    this.setVisibility(this.showStrands, this.showGuides);
  }

  /** Disposes prepared groups that won't be committed (superseded by a newer edit). */
  discardGroups(pending: PendingGroups): void {
    for (const g of pending.built.values()) g.dispose();
  }

  /** `prepareGroups` + `commitGroups` at once (the new groups compile on first use). */
  rebuildGroups(names: Iterable<string>): void {
    this.commitGroups(this.prepareGroups(names));
  }

  /**
   * Regrows one group's guide shapes from the current style at their existing roots (needs `keepRoots` in the groom
   * options). For edits that don't move hair to new places it is far cheaper than a regroom and keeps the strands
   * bound to the same guides. Same pose rule as build(). `subset` limits it to some guides. `deferBounds` leaves the
   * hair bounds as they were (for edits every frame): call `refreshBounds` once they're done.
   */
  reshapeGroup(name: string, subset?: ArrayLike<number>, deferBounds = false): void {
    const g = this.groups.find((x) => x.name === name);
    const index = this.opts.style.groups.findIndex((s) => s.name === name);
    if (!g || index < 0) return;
    const opts = { colliders: this.colliders, ...this.opts.groom };
    g.refreshStatic(reshapeGroomGroup(this.opts.growth, this.opts.style, g.data, index, opts, subset));
    if (deferBounds) this.groom = { ...this.groom, groups: this.groups.map((x) => x.data) };
    else this.refreshGroom();
  }

  /** Recomputes the hair bounds from the guides (after `reshapeGroup` calls that deferred it). */
  refreshBounds(): void {
    this.refreshGroom();
  }

  private createGroup(data: GroomGroupData, previous?: HairParamsData): HairGroup {
    const name = data.spec.name;
    const p = this.opts.paramObjects?.[name] ?? previous ?? mergeHairParams(this.opts.params?.[name] ?? {});
    return new HairGroup(data, this.deformer, this.colliders, {
      params: p,
      lighting: this.services.lighting,
      shadowMap: this.shadowMap,
      shadowLayer: this.shadowLayer,
      release: this.services.release,
      compactStrands: this.opts.compactStrands,
    });
  }

  private removeGroup(g: HairGroup): void {
    this.root.remove(g.mesh, g.shadowMesh, g.guideLines);
    g.dispose();
  }

  /** The groom data and bounds after groups changed one by one. */
  private refreshGroom(): void {
    const groups = this.groups.map((g) => g.data);
    this.groom = { groups, ...groomBounds(groups) };
    this.updateBounds();
  }

  /** Bounds are tracked relative to the bounds object so they follow the character. */
  private updateBounds(): void {
    const bo = this.opts.boundsObject;
    this.bindBoundsLocal.set(this.groom.boundsCenter.clone(), this.groom.boundsRadius);
    if (bo) {
      bo.updateWorldMatrix(true, false);
      this.bindScale = bo.matrixWorld.getMaxScaleOnAxis();
      this.bindBoundsLocal.center.applyMatrix4(bo.matrixWorld.clone().invert());
    }
  }

  setVisibility(strands: boolean, guides: boolean): void {
    this.showStrands = strands;
    this.showGuides = guides;
    for (const g of this.groups) {
      g.mesh.visible = strands && g.enabled;
      g.guideLines.visible = guides && g.enabled;
    }
  }

  /** Current world-space bounding sphere of the hair (approximate). */
  getBoundingSphere(target: THREE.Sphere): THREE.Sphere {
    target.copy(this.bindBoundsLocal);
    const bo = this.opts.boundsObject;
    if (bo) {
      target.center.applyMatrix4(bo.matrixWorld);
      target.radius *= bo.matrixWorld.getMaxScaleOnAxis() / Math.max(1e-6, this.bindScale);
    }
    return target;
  }

  /** Hair shadow density used for shadows cast onto bodies (synced from the first enabled group). */
  readonly bodyShadowDensity = uniform(250);

  reset(): void {
    this.needsReset = true;
  }

  dispose(): void {
    for (const g of this.groups) g.dispose();
    this.groups = [];
    this.deformer.dispose(this.services.release);
    this.root.removeFromParent();
  }
}
