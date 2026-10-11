import {
  abs,
  cameraPosition,
  color,
  cos,
  float,
  max,
  mix,
  mx_noise_float,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

import type { HairPanelOptions } from '../app/Gui';
import { count } from '../app/Stats';
import { ColliderSet } from '../hair/colliders';
import { createGrassStyle, type GrassStyleParams } from '../hair/groom/styles/grassStyle';
import { rigidGrowth } from '../hair/growth';
import type { HairInstance } from '../hair/HairInstance';
import { mergeHairParams, type HairParamsData } from '../hair/params';
import type { N } from '../hair/sim/tslUtil';
import type { ExampleContext } from './Example';
import type { FoxCharacter } from './FoxCharacter';

export type GrassParams = Record<'grass' | 'stalks', HairParamsData>;

/**
 * Grass blades are millimetres wide and sparse next to hair, so their panels cover larger widths and gaps; and the
 * ground never moves, has no body shape, always faces the camera and doesn't curl, so those controls are left out.
 */
export const GRASS_PANEL: HairPanelOptions = {
  ranges: {
    rootWidth: { min: 0.2, max: 5 },
    tipWidth: { min: 0, max: 5 },
    taper: { min: 0.1, max: 10 },
    frizz: { min: 0, max: 20 },
    collisionMargin: { min: 0, max: 60 },
    selfShadowDensity: { min: 0, max: 50 },
  },
  hide: ['curlRadius', 'curlTurns', 'curlRamp', 'followRoot', 'sdfRootRange', 'backCull'],
};

/**
 * Fox capsules grow by this much for the grass, so a step parts a swath rather than slipping between guides.
 * The capsules hug the body and the fur stands off it, so the body grows too: grass parting a little early
 * reads better than blades poking through the fur.
 */
const PUSH_INFLATE: Record<string, number> = {
  lFoot: 1.8,
  rFoot: 1.8,
  lFore: 1.7,
  rFore: 1.7,
  lShin: 1.6,
  rShin: 1.6,
  lArm: 1.4,
  rArm: 1.4,
  lThigh: 1.35,
  rThigh: 1.35,
  hips: 1.25,
  chest: 1.25,
  neck: 1.25,
  head: 1.25,
  snout: 1.4,
  tail1: 1.3,
  tail2: 1.3,
  tail3: 1.4,
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
        // Drawn blades sit up to half a guide spacing (~2.5 cm) from the guide that collided.
        collisionMargin: 0.025,
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
        rootWidth: 0.0015 * widen,
        tipWidth: 0.0001 * widen,
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
        collisionMargin: 0.035,
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
 * Matted blades under the grass, in the blades' own colours, so the ground showing between them (more of it far
 * away, where the view LOD thins the blades) reads as more grass rather than bare soil. `xz` is in metres.
 */
function thatchColor(xz: N): N {
  // Three layers of blades, each lying along a direction that wanders gently across the field.
  const flow = mx_noise_float(vec3(xz.x, 0, xz.y).mul(0.35)).mul(1.2);
  let blades: N = float(0);
  [0, 1.0, 2.1].forEach((offset, i) => {
    const c = cos(flow.add(offset));
    const s = sin(flow.add(offset));
    const along = xz.x.mul(c).add(xz.y.mul(s));
    const across = xz.y.mul(c).sub(xz.x.mul(s));
    // Thin bright lines along the noise's ridges: long along the blade (~15 cm), a few mm across.
    const n = mx_noise_float(vec3(along.mul(7), across.mul(110), i * 7.3));
    const ridge = pow(float(1).sub(abs(n)), 5);
    blades = max(blades, ridge.mul(0.85 - i * 0.15));
  });
  // The lines are finer than a pixel a few metres out: fade them to their average there instead of shimmering.
  const detail = float(1).sub(smoothstep(2.5, 9, positionWorld.sub(cameraPosition).length()));
  blades = mix(float(0.3), blades, detail);
  // Patches of green and of straw, like the blades' own dryness.
  const dry = smoothstep(-0.35, 0.45, mx_noise_float(vec3(xz.x, 5, xz.y).mul(0.4)));
  const blade = mix(color('#5d6830'), color('#a39260'), dry);
  return mix(color('#3d4221'), blade, blades.mul(0.75));
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
    const geometry = new THREE.PlaneGeometry(size, size, 360, 360).rotateX(-Math.PI / 2);
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

    // Thatch under the grass, blending back into the floor beyond it.
    const floor = app.floor.material as THREE.MeshPhysicalNodeMaterial;
    this.savedFloorColor = floor.colorNode;
    const thatch = thatchColor(positionLocal.xz);
    const r = positionLocal.xz.length();
    const base = (this.savedFloorColor ?? thatch) as THREE.Node<'color'>;
    floor.colorNode = mix(thatch, base, smoothstep(style.radius * 0.6, style.radius * 1.05, r));
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
    return `grass ${count(grass?.activeStrands ?? 0)} blades · ${count(stalks?.activeStrands ?? 0)} stalks`;
  }

  dispose(): void {
    this.ctx.hair.remove(this.instance);
    const floor = this.ctx.app.floor.material as THREE.MeshPhysicalNodeMaterial;
    floor.colorNode = this.savedFloorColor;
    floor.needsUpdate = true;
  }
}
