import { mix, positionLocal, smoothstep, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { ColliderSet } from '../hair/colliders';
import { createGrassStyle, type GrassStyleParams } from '../hair/groom/styles/grassStyle';
import { rigidGrowth } from '../hair/growth';
import type { HairInstance } from '../hair/HairInstance';
import { mergeHairParams, type HairParamsData } from '../hair/params';
import type { ExampleContext } from './Example';
import type { FoxCharacter } from './FoxCharacter';

export type GrassParams = Record<'grass' | 'stalks', HairParamsData>;

/** Fox capsules grow by this much for the grass, so a step parts a swath rather than slipping between guides. */
const PUSH_INFLATE: Record<string, number> = {
  lFoot: 1.6,
  rFoot: 1.6,
  lFore: 1.5,
  rFore: 1.5,
  lShin: 1.35,
  rShin: 1.35,
  lArm: 1.2,
  rArm: 1.2,
  lThigh: 1.2,
  rThigh: 1.2,
  tail1: 1.1,
  tail2: 1.1,
  tail3: 1.1,
};

/**
 * Default grass tuning: stiff enough to stand against (reduced) gravity and spring back, loose enough to sway.
 * Lower quality presets draw fewer blades, so they get wider ones to still cover the ground.
 */
export function createGrassParams(substeps: number, strandScale: number): GrassParams {
  const widen = THREE.MathUtils.clamp(1 / Math.sqrt(strandScale), 1, 2);
  const shading = {
    textureInfluence: 1,
    specular: 0.25,
    roughness: 0.6,
    backlit: 0.9,
    scatter: 0.9,
  };
  return {
    grass: mergeHairParams({
      physics: {
        substeps,
        gravity: { x: 0, y: -3, z: 0 },
        globalStiffness: 0.09,
        globalTip: 0.25,
        globalCurve: 1.5,
        localStiffness: 0.85,
        localTip: 0.7,
        damping: 7,
        drag: 2.2,
        followRoot: 0,
        maxVelocity: 3,
        collisionMargin: 0.012,
        collisionFriction: 0.7,
        rootColliderRange: 0,
        rootPlane: 0.04,
        rootPlaneRange: 1,
      },
      style: {
        guideBlend: 0.5,
        clump: 0.2,
        clumpShape: 1,
        frizz: 0.006,
        frizzFrequency: 2,
        rootWidth: 0.0022 * widen,
        tipWidth: 0.00015 * widen,
        taper: 2,
        // The field spans every depth: skip blades out of view and thin out distant ones (sub-pixel anyway).
        cullOffscreen: true,
        lodDistance: 4.5,
      },
      shading: {
        ...shading,
        rootColor: '#3e4a22',
        tipColor: '#c9b27c',
        gradientStart: 0.2,
        hueJitter: 0.06,
        valueJitter: 0.25,
        selfShadowDensity: 10,
        aoRoot: 0.25,
        aoRange: 0.5,
        tipFade: 0.2,
      },
    }),
    stalks: mergeHairParams({
      physics: {
        substeps,
        gravity: { x: 0, y: -2, z: 0 },
        globalStiffness: 0.06,
        globalTip: 0.15,
        globalCurve: 1,
        localStiffness: 0.9,
        localTip: 0.8,
        damping: 5,
        drag: 3,
        followRoot: 0,
        maxVelocity: 4,
        collisionMargin: 0.015,
        collisionFriction: 0.6,
        rootColliderRange: 0,
        rootPlane: 0.04,
        rootPlaneRange: 1,
      },
      // Thin stems that swell into a seed head at the very top.
      style: {
        guideBlend: 0.7,
        clump: 0.5,
        clumpShape: 0.6,
        frizz: 0.004,
        frizzFrequency: 3,
        rootWidth: 0.0014 * widen,
        tipWidth: 0.003 * widen,
        taper: 7,
        // Stalks are sparse, so they thin out later than the grass.
        cullOffscreen: true,
        lodDistance: 6,
      },
      shading: {
        ...shading,
        rootColor: '#5a5a2e',
        tipColor: '#dcc28c',
        gradientStart: 0.55,
        gradientEnd: 0.95,
        hueJitter: 0.04,
        valueJitter: 0.2,
        selfShadowDensity: 6,
        aoRoot: 0.3,
        aoRange: 0.6,
        tipFade: 0.05,
      },
    }),
  };
}

/**
 * A field of prairie grass on the floor, groomed and simulated as hair: a ground plane is the growth mesh,
 * wind is the shared hair wind, and the foxes' capsules (copied, slightly inflated) push it aside.
 */
export class GrassField {
  readonly colliders = new ColliderSet();
  readonly instance: HairInstance;
  private readonly ctx: ExampleContext;
  private readonly style: GrassStyleParams;
  private readonly anchor = new THREE.Object3D();
  private readonly savedFloorColor: THREE.MeshPhysicalNodeMaterial['colorNode'];

  constructor(ctx: ExampleContext, style: GrassStyleParams, params: GrassParams) {
    this.ctx = ctx;
    this.style = style;
    const { app, hair, quality } = ctx;
    // Fine, even triangles: the groomer weights triangles by their density at only 4 points.
    const size = style.radius * 2;
    const geometry = new THREE.PlaneGeometry(size, size, 180, 180).rotateX(-Math.PI / 2);
    const { source, growth } = rigidGrowth(geometry, this.anchor);
    geometry.dispose();
    this.instance = hair.createInstance({
      name: 'grass',
      source,
      growth,
      style: createGrassStyle(style),
      colliders: this.colliders,
      paramObjects: params,
      // No colliders while grooming: a fox standing in the field would otherwise bake permanent holes.
      groom: {
        seed: style.seed,
        strandScale: Math.min(quality.strandScale, 1.5),
        guideScale: quality.guideScale,
        colliders: null,
      },
      // The field is far larger than a character, so its shadow map needs more texels.
      shadowResolution: Math.min(2048, quality.hairShadowSize * 2),
    });

    // Soil under the grass, blending back into the floor beyond it.
    const floor = app.floor.material as THREE.MeshPhysicalNodeMaterial;
    this.savedFloorColor = floor.colorNode;
    const soil = uniform(new THREE.Color('#2e2618'));
    const r = positionLocal.xz.length();
    const base = (this.savedFloorColor ?? soil) as THREE.Node<'color'>;
    floor.colorNode = mix(soil, base, smoothstep(style.radius * 0.6, style.radius * 1.05, r));
    floor.needsUpdate = true;
  }

  /** Copies the foxes' colliders (attached to their bones) so they part the grass. */
  attachFoxes(foxes: FoxCharacter[]): void {
    this.colliders.clear();
    for (const fox of foxes) {
      for (const c of fox.colliders.capsules) {
        this.colliders.add({
          ...c,
          a: c.a.clone(),
          b: c.b.clone(),
          radius: c.radius * (PUSH_INFLATE[c.name] ?? 1),
        });
      }
    }
    this.colliders.update(true);
  }

  /** Regrows the grass from the current style params (lengths, stalk amount). */
  regroom(): void {
    this.instance.setStyle(createGrassStyle(this.style));
    this.instance.build();
  }

  syncParams(): void {
    for (const g of this.instance.groups) g.syncParams();
  }

  hud(): string {
    const [grass, stalks] = this.instance.groups;
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    return `grass ${k(grass?.activeStrands ?? 0)} blades · ${k(stalks?.activeStrands ?? 0)} stalks`;
  }

  dispose(): void {
    this.ctx.hair.remove(this.instance);
    const floor = this.ctx.app.floor.material as THREE.MeshPhysicalNodeMaterial;
    floor.colorNode = this.savedFloorColor;
    floor.needsUpdate = true;
  }
}
