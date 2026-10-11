import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { buildPaintMesh, nearestVertex, subdivideMidpoint } from './paintMesh';

function area(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.index!.array;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let sum = 0;
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(p, idx[t]);
    b.fromBufferAttribute(p, idx[t + 1]).sub(a);
    c.fromBufferAttribute(p, idx[t + 2]).sub(a);
    sum += b.cross(c).length() / 2;
  }
  return sum;
}

function edgeCount(g: THREE.BufferGeometry): number {
  const idx = g.index!.array;
  const edges = new Set<string>();
  for (let t = 0; t < idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k];
      const b = idx[t + ((k + 1) % 3)];
      edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  return edges.size;
}

describe('midpoint subdivision', () => {
  const sphere = new THREE.SphereGeometry(0.1, 16, 12);
  const sub = subdivideMidpoint(sphere);

  it('adds a vertex per edge and splits each triangle in four', () => {
    expect(sub.getAttribute('position').count).toBe(
      sphere.getAttribute('position').count + edgeCount(sphere),
    );
    expect(sub.index!.count).toBe(sphere.index!.count * 4);
  });

  it('keeps the surface exactly (same area) and interpolates every attribute', () => {
    expect(area(sub)).toBeCloseTo(area(sphere), 7);
    expect(sub.getAttribute('uv').count).toBe(sub.getAttribute('position').count);
    const n = sub.getAttribute('normal');
    for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5);
  });
});

describe('paint mesh', () => {
  const sphere = new THREE.SphereGeometry(0.1, 24, 16);
  const mesh = buildPaintMesh(sphere, 0, 0.02);

  it('welds UV-seam and pole copies into one paint vertex', () => {
    expect(mesh.count).toBeLessThan(sphere.getAttribute('position').count);
    // Every render vertex maps to a paint vertex at its own position.
    const p = sphere.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const w = mesh.weld[i];
      expect(
        Math.hypot(
          p.getX(i) - mesh.positions[w * 3],
          p.getY(i) - mesh.positions[w * 3 + 1],
          p.getZ(i) - mesh.positions[w * 3 + 2],
        ),
      ).toBeLessThan(1e-6);
    }
  });

  it('has symmetric neighbours', () => {
    for (let i = 0; i < mesh.count; i++)
      for (let j = mesh.neighborStart[i]; j < mesh.neighborStart[i + 1]; j++) {
        const q = mesh.neighbors[j];
        const back = Array.from(mesh.neighbors.subarray(mesh.neighborStart[q], mesh.neighborStart[q + 1]));
        expect(back).toContain(i);
      }
  });

  it('mirrors about the midline onto the reflected vertex', () => {
    for (let i = 0; i < mesh.count; i += 7) {
      const j = mesh.mirror[i];
      expect(mesh.positions[j * 3]).toBeCloseTo(-mesh.positions[i * 3], 4);
      expect(mesh.positions[j * 3 + 1]).toBeCloseTo(mesh.positions[i * 3 + 1], 4);
    }
  });

  it('finds the nearest vertex facing the right way', () => {
    const i = 5;
    const p = mesh.positions;
    const found = nearestVertex(
      mesh.hash,
      p[i * 3],
      p[i * 3 + 1],
      p[i * 3 + 2],
      mesh.normals,
      mesh.normals[i * 3],
      mesh.normals[i * 3 + 1],
      mesh.normals[i * 3 + 2],
    );
    expect(found).toBe(i);
  });
});
