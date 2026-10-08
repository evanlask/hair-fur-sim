import * as THREE from 'three/webgpu';

import type { GroomStyle } from '../types';

export interface BallStyleParams {
  length: number;
  /** Per-guide length variation (± fraction). */
  lengthJitter: number;
  /** Per-render-strand shortening (see GroomGroupSpec.lengthVariation). */
  lengthVariation: number;
  /** 1 = strands grow along the normal, 0 = combed flat along the surface (downwards). */
  lift: number;
  /** How quickly strands bend towards gravity (1/m). */
  droop: number;
  /** Wave amplitude (m). */
  wave: number;
  waveCount: number;
  guideCount: number;
  strandCount: number;
  guideParticles: number;
  strandPoints: number;
}

export const defaultBallStyle = (): BallStyleParams => ({
  length: 0.22,
  lengthJitter: 0.15,
  lengthVariation: 0.25,
  lift: 0.55,
  droop: 6,
  wave: 0.004,
  waveCount: 2,
  guideCount: 1600,
  strandCount: 90000,
  guideParticles: 16,
  strandPoints: 24,
});

const DOWN = new THREE.Vector3(0, -1, 0);

/** Uniform hair over any surface, combed downwards and drooping with gravity. */
export function createBallStyle(p: BallStyleParams): GroomStyle {
  const comb = new THREE.Vector3();
  return {
    groups: [
      {
        name: 'hair',
        guideCount: p.guideCount,
        strandCount: p.strandCount,
        guideParticles: p.guideParticles,
        strandPoints: p.strandPoints,
        lengthVariation: p.lengthVariation,
        widthVariation: 0.35,
        interpSpace: 'world',
      },
    ],
    density: () => 1,
    group: () => 0,
    shape(sp, out) {
      const n = sp.normal;
      comb.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
      if (comb.lengthSq() < 1e-4) comb.set(1, 0, 0).addScaledVector(n, -n.x);
      comb.normalize();
      // Position hash, since shape() gets no RNG.
      const h = Math.sin(sp.position.x * 91.7 + sp.position.y * 47.3 + sp.position.z * 73.1) * 0.5 + 0.5;
      out.length = p.length * (1 + p.lengthJitter * (h * 2 - 1));
      out.direction
        .copy(n)
        .multiplyScalar(p.lift)
        .addScaledVector(comb, 1 - p.lift)
        .normalize();
      out.bendTarget.copy(DOWN);
      out.bendRate = p.droop;
      out.waveAmplitude = p.wave;
      out.waveCount = p.waveCount;
    },
  };
}
