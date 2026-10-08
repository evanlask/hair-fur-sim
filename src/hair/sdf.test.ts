import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { Rng } from '../util/rng';
import { bakeMeshSdf, sampleSdf, type SdfGrid } from './sdf';

const R = 0.3;
const CELL = 0.02;
const BAND = 0.06;

function bake(
  geometry: THREE.BufferGeometry,
  extent: number,
  attribute?: Float32Array,
  closestVertex = false,
) {
  return bakeMeshSdf(
    geometry.getAttribute('position').array as Float32Array,
    geometry.getAttribute('normal').array as Float32Array,
    geometry.index!.array,
    new THREE.Vector3(-extent, -extent, -extent),
    new THREE.Vector3(extent, extent, extent),
    CELL,
    BAND,
    attribute,
    closestVertex,
  );
}

function cellIndex(g: SdfGrid, p: THREE.Vector3): number {
  const i = Math.floor((p.x - g.min.x) / g.cell);
  const j = Math.floor((p.y - g.min.y) / g.cell);
  const k = Math.floor((p.z - g.min.z) / g.cell);
  return (k * g.ny + j) * g.nx + i;
}

function randomDirections(count: number, seed: number): THREE.Vector3[] {
  const rng = new Rng(seed);
  return Array.from({ length: count }, () =>
    new THREE.Vector3(rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5).normalize(),
  );
}

describe('mesh SDF', () => {
  const sphere = new THREE.SphereGeometry(R, 48, 32);
  const grid = bake(sphere, R + 0.1);

  it('matches the distance to a sphere inside the band, negative inside', () => {
    const p = new THREE.Vector3();
    for (const dir of randomDirections(50, 1)) {
      for (const r of [R - 0.03, R - 0.01, R + 0.01, R + 0.03]) {
        // Tolerance covers the tessellation (flat triangles sit up to ~1.5 mm inside the sphere).
        expect(sampleSdf(grid, p.copy(dir).multiplyScalar(r))).toBeCloseTo(r - R, 2);
      }
    }
  });

  it('flood-fills the sign beyond the band', () => {
    expect(sampleSdf(grid, new THREE.Vector3(0, 0, 0))).toBeCloseTo(-BAND, 5);
    expect(sampleSdf(grid, new THREE.Vector3(0.05, -0.1, 0.08))).toBeCloseTo(-BAND, 5);
    expect(sampleSdf(grid, new THREE.Vector3(0.38, 0, 0))).toBeCloseTo(BAND, 5);
    expect(sampleSdf(grid, new THREE.Vector3(0.36, 0.36, 0.36))).toBeCloseTo(BAND, 5);
  });

  it('has an outward unit gradient at the surface', () => {
    const p = new THREE.Vector3();
    const grad = new THREE.Vector3();
    for (const dir of randomDirections(50, 2)) {
      sampleSdf(grid, p.copy(dir).multiplyScalar(R), grad);
      expect(grad.length()).toBeCloseTo(1, 1);
      expect(grad.normalize().dot(dir)).toBeGreaterThan(0.99);
    }
  });

  it('returns Infinity outside the grid', () => {
    expect(sampleSdf(grid, new THREE.Vector3(1, 0, 0))).toBe(Infinity);
    expect(sampleSdf(grid, new THREE.Vector3(0, -1, 0))).toBe(Infinity);
  });

  it('gets the sign right around the sharp edges and corners of a box', () => {
    const box = bake(new THREE.BoxGeometry(0.4, 0.4, 0.4), 0.3);
    expect(sampleSdf(box, new THREE.Vector3(0, 0, 0))).toBeCloseTo(-BAND, 5);
    expect(sampleSdf(box, new THREE.Vector3(0.18, 0.18, 0.18))).toBeLessThan(0);
    expect(sampleSdf(box, new THREE.Vector3(0.23, 0.23, 0))).toBeGreaterThan(0);
    // Diagonally off a corner: the closest point is the corner itself.
    expect(sampleSdf(box, new THREE.Vector3(0.23, 0.23, 0.23))).toBeCloseTo(Math.sqrt(3) * 0.03, 2);
  });

  it('carries per-vertex attributes and closest vertices into every cell, including flood-filled ones', () => {
    const positions = sphere.getAttribute('position');
    const attribute = new Float32Array(positions.count * 4);
    for (let v = 0; v < positions.count; v++) attribute[v * 4] = 1;
    const g = bake(sphere, R + 0.1, attribute, true);

    for (let c = 0; c < g.data.length; c++) {
      expect(g.weights![c * 4]).toBeCloseTo(1, 5);
      expect(g.vertex![c]).toBeGreaterThanOrEqual(0);
      expect(g.vertex![c]).toBeLessThan(positions.count);
    }
    // The cell just above the north pole maps to a vertex near the pole.
    const v = g.vertex![cellIndex(g, new THREE.Vector3(0, R + 0.01, 0))];
    expect(positions.getY(v)).toBeGreaterThan(R * 0.95);
  });
});
