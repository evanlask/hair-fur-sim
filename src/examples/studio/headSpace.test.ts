import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import type { HeadFrame } from './heads';
import { FLOW_PRESETS, presetFlow, scalpDensity, scalpMask, type FlowPreset } from './headSpace';
import { buildPaintMesh } from './paintMesh';

/** A round "head" of radius r at the origin whose hairline runs round its equator. */
function sphereFrame(r: number): HeadFrame {
  return {
    center: new THREE.Vector3(),
    radii: new THREE.Vector3(r, r, r),
    crown: new THREE.Vector3(0, r, -0.3 * r),
    midlineX: 0,
    hairline: [
      [0, 0],
      [180, 0],
    ],
    ears: [],
    bare: [],
  };
}

describe('head space', () => {
  const frame = sphereFrame(0.1);
  const paint = buildPaintMesh(new THREE.SphereGeometry(0.1, 40, 28), 0, 0.02);

  it('combs every preset along the surface', () => {
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const out = new THREE.Vector3();
    for (const preset of Object.keys(FLOW_PRESETS) as FlowPreset[])
      for (let i = 0; i < paint.count; i += 9) {
        presetFlow(
          preset,
          frame,
          p.fromArray(paint.positions, i * 3),
          n.fromArray(paint.normals, i * 3),
          out,
        );
        expect(out.length()).toBeCloseTo(1, 5);
        expect(Math.abs(out.dot(n))).toBeLessThan(1e-5);
      }
  });

  it('masks the scalp above the hairline', () => {
    expect(scalpMask(frame, new THREE.Vector3(0, 0.1, 0))).toBe(1);
    expect(scalpMask(frame, new THREE.Vector3(0, -0.1, 0))).toBe(0);
    const d = scalpDensity(frame, paint);
    for (let i = 0; i < paint.count; i++) {
      const y = paint.positions[i * 3 + 1];
      if (y > 0.01) expect(d[i]).toBe(1);
      if (y < -0.006) expect(d[i]).toBe(0);
    }
  });
});
