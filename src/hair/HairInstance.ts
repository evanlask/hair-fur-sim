import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { ColliderSet } from './colliders';
import { buildGroom, type GroomOptions } from './groom/Groomer';
import type { GroomData, GroomStyle, GrowthMesh } from './groom/types';
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
}

/** Injected by HairSystem.createInstance. */
export interface HairInstanceServices {
  lighting: HairLighting;
  shadowMap: HairShadowMap;
  shadowLayer: number;
  /** Frees GPU buffers of disposed groups (and the deformer). */
  release: ReleaseBuffers;
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
    for (const g of this.groups) {
      this.root.remove(g.mesh, g.shadowMesh, g.guideLines);
      g.dispose();
    }
    this.opts.groom = { ...this.opts.groom, ...groomOptions };
    this.colliders.update(true);
    this.groom = buildGroom(this.opts.growth, this.opts.style, {
      colliders: this.colliders,
      ...this.opts.groom,
    });
    this.groups = this.groom.groups.map((data) => {
      const name = data.spec.name;
      const p =
        this.opts.paramObjects?.[name] ??
        previous.get(name) ??
        mergeHairParams(this.opts.params?.[name] ?? {});
      const group = new HairGroup(data, this.deformer, this.colliders, {
        params: p,
        lighting: this.services.lighting,
        shadowMap: this.shadowMap,
        shadowLayer: this.shadowLayer,
        release: this.services.release,
      });
      this.root.add(group.mesh, group.shadowMesh, group.guideLines);
      return group;
    });
    // Bounds are tracked relative to the bounds object so they follow the character.
    const bo = this.opts.boundsObject;
    this.bindBoundsLocal.set(this.groom.boundsCenter.clone(), this.groom.boundsRadius);
    if (bo) {
      bo.updateWorldMatrix(true, false);
      this.bindScale = bo.matrixWorld.getMaxScaleOnAxis();
      this.bindBoundsLocal.center.applyMatrix4(bo.matrixWorld.clone().invert());
    }
    this.setVisibility(this.showStrands, this.showGuides);
    this.needsReset = true;
  }

  setVisibility(strands: boolean, guides: boolean): void {
    this.showStrands = strands;
    this.showGuides = guides;
    for (const g of this.groups) {
      g.mesh.visible = strands;
      g.guideLines.visible = guides;
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

  /** Hair shadow density used for shadows cast onto bodies (synced from the first group). */
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
