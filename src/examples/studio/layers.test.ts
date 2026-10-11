import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import type { HeadFrame } from './heads';
import { emptyLayer } from './layers';
import { buildPaintMesh } from './paintMesh';

const frame: HeadFrame = {
  center: new THREE.Vector3(),
  radii: new THREE.Vector3(0.1, 0.1, 0.1),
  crown: new THREE.Vector3(0, 0.1, -0.03),
  midlineX: 0,
  hairline: [
    [0, 0],
    [180, 0],
  ],
  ears: [],
  bare: [],
};
const paint = buildPaintMesh(new THREE.SphereGeometry(0.1, 32, 24), 0, 0.02);

describe('layers', () => {
  it('starts a new layer with nothing painted, combed along the skin', () => {
    const layer = emptyLayer({ head: { frame }, paint }, 4);
    expect(layer.fields.density.every((d) => d === 0)).toBe(true);
    expect('kind' in layer).toBe(false);
    for (let i = 0; i < paint.count; i++) {
      const flow = new THREE.Vector3().fromArray(layer.fields.flow, i * 3);
      const n = new THREE.Vector3().fromArray(paint.normals, i * 3);
      expect(flow.length()).toBeCloseTo(1, 4);
      expect(Math.abs(flow.dot(n))).toBeLessThan(1e-3);
    }
  });
});
