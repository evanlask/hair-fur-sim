import * as THREE from 'three/webgpu';

import { fbm2, hash2, worley2 } from '../../../util/noise';
import type { GroomStyle, SurfacePoint } from '../types';

export interface GrassStyleParams {
  /** Radius (m) of the field around the origin; density fades out over `fade` towards it. */
  radius: number;
  fade: number;
  /** Multiplier on the understory blade length (base ~6–26 cm). */
  height: number;
  /** Multiplier on the seed stalk length (base ~40–85 cm). */
  stalkHeight: number;
  /** Multiplier on how much ground the stalk drifts cover (0 = none). */
  stalkAmount: number;
  guideCount: number;
  strandCount: number;
  stalkGuides: number;
  stalkStrands: number;
  seed: number;
}

export const defaultGrassStyle = (): GrassStyleParams => ({
  radius: 4.5,
  fade: 1.2,
  height: 1,
  stalkHeight: 1,
  stalkAmount: 1,
  guideCount: 28000,
  strandCount: 450000,
  stalkGuides: 3500,
  stalkStrands: 24000,
  seed: 11,
});

export const GRASS_GROUP = 0;
export const STALK_GROUP = 1;

/** Tuft (bunchgrass clump) spacing in meters. */
const TUFT_CELL = 0.16;
/** Densities below this are bare ground, so sparse fringes don't strand render strands far from any guide. */
const MIN_DENSITY = 0.06;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Prairie grass on flat ground (y up): a dense understory of tufted blades in two layered groups with
 * sparser, taller seed stalks standing in drifts. Bare patches, tuft structure, lengths and dryness all come
 * from position noise, so the groom is deterministic.
 */
export function createGrassStyle(p: GrassStyleParams): GroomStyle {
  const tuft = { x: 0, z: 0, dist: 0, id: 0 };
  const lean = new THREE.Vector3();
  const edgeAt = (x: number, z: number) => 1 - smoothstep(p.radius - p.fade, p.radius, Math.hypot(x, z));
  const s = p.seed;

  /** Where the seed stalks stand (0..1). */
  const stalkDrift = (x: number, z: number) =>
    Math.min(1, p.stalkAmount * smoothstep(0.45, 0.72, fbm2(x * 0.35 + 17, z * 0.35, 3, s + 3)));

  const density = (sp: SurfacePoint, group: number): number => {
    const { x, z } = sp.position;
    const edge = edgeAt(x, z);
    if (edge <= 0) return 0;
    let d: number;
    if (group === STALK_GROUP) {
      d = edge * stalkDrift(x, z);
    } else {
      const patch = smoothstep(0.28, 0.55, fbm2(x * 0.6, z * 0.6, 3, s));
      worley2(x, z, TUFT_CELL, s + 1, tuft);
      const inTuft = 1 - smoothstep(0.3, 0.85, tuft.dist);
      // Thinner patches rather than bare ones, and always a short understory beneath the stalks.
      const open = mix(0.35, 1, patch) * mix(0.5, 1, inTuft);
      d = edge * Math.max(open, 0.85 * stalkDrift(x, z));
    }
    return d < MIN_DENSITY ? 0 : d;
  };

  return {
    groups: [
      {
        name: 'grass',
        guideCount: p.guideCount,
        strandCount: p.strandCount,
        guideParticles: 5,
        strandPoints: 6,
        lengthVariation: 0.6,
        widthVariation: 0.5,
        interpSpace: 'world',
      },
      {
        name: 'stalks',
        guideCount: p.stalkGuides,
        strandCount: p.stalkStrands,
        guideParticles: 7,
        strandPoints: 10,
        lengthVariation: 0.25,
        widthVariation: 0.3,
        interpSpace: 'world',
      },
    ],
    density,
    group: () => -1,
    shape(sp, out, group) {
      const { x, z } = sp.position;
      const edge = edgeAt(x, z);
      const h = hash2(Math.floor(x * 4096), Math.floor(z * 4096), s + 7);
      // Gentle field-wide lean so the grass isn't perfectly upright.
      const a = fbm2(x * 0.5, z * 0.5, 2, s + 4) * Math.PI * 4;
      if (group === STALK_GROUP) {
        out.length = p.stalkHeight * mix(0.4, 0.85, h) * Math.max(0.3, Math.sqrt(edge));
        lean.set(Math.cos(a), 0, Math.sin(a));
        out.direction
          .set(0, 1, 0)
          .addScaledVector(lean, 0.08 + 0.08 * h)
          .normalize();
        out.bendTarget.copy(lean).setY(0.2).normalize();
        out.bendRate = 0.8;
      } else {
        worley2(x, z, TUFT_CELL, s + 1, tuft);
        // Blades fan out from the tuft centre and arch over towards the outside.
        lean.set(x - tuft.x, 0, z - tuft.z).divideScalar(TUFT_CELL);
        lean.x += Math.cos(a) * 0.15;
        lean.z += Math.sin(a) * 0.15;
        const centre = 1 - Math.min(1, tuft.dist);
        out.length =
          p.height *
          mix(0.06, 0.26, fbm2(x * 1.3, z * 1.3, 2, s + 5)) *
          mix(0.7, 1.1, centre) *
          mix(0.75, 1.25, h) *
          Math.max(0.25, Math.sqrt(edge));
        out.direction.set(0, 1, 0).addScaledVector(lean, 0.55).normalize();
        if (lean.lengthSq() < 1e-6) lean.set(1, 0, 0);
        out.bendTarget.copy(lean).normalize().setY(-0.35).normalize();
        out.bendRate = mix(2.5, 6, hash2(Math.floor(tuft.x * 97), Math.floor(tuft.z * 97), s + 8));
      }
      out.length = Math.max(0.02, out.length);
      out.waveAmplitude = 0;
      out.waveCount = 0;
    },
    color(sp, group) {
      const { x, z } = sp.position;
      const h = hash2(Math.floor(x * 8192), Math.floor(z * 8192), s + 9);
      // Some blades are dead and grey-straw.
      if (group === GRASS_GROUP && h < 0.1) return [0.85, 0.8, 0.74];
      const dry = smoothstep(0.3, 0.7, fbm2(x * 0.4, z * 0.4, 2, s + 6) + (h - 0.5) * 0.3);
      return [mix(0.72, 1, dry), mix(1, 0.92, dry), mix(0.6, 0.72, dry)];
    },
  };
}
