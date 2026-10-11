import * as THREE from 'three/webgpu';

import { SpatialHash } from '../../hair/groom/SpatialHash';
import { weldGroups, weldedNormals } from '../../util/weld';

/**
 * Splits every triangle into four at its edge midpoints. The surface keeps its exact shape (midpoints lie on the
 * edges); float attributes are averaged at the midpoints and normals renormalized. Edges are keyed by their
 * vertex pair, so UV-seam copies of an edge get their own midpoints, as the seam needs.
 */
export function subdivideMidpoint(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = geometry.index!.array;
  const n = geometry.getAttribute('position').count;
  const names = Object.keys(geometry.attributes);
  const src = names.map((name) => geometry.getAttribute(name));
  const values: number[][] = src.map((a) => {
    const out: number[] = [];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out.push(a.getComponent(i, k));
    return out;
  });
  const mid = new Map<number, number>();
  let count = n;
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * n + b : b * n + a;
    let m = mid.get(key);
    if (m === undefined) {
      m = count++;
      mid.set(key, m);
      src.forEach((attr, ai) => {
        const k = attr.itemSize;
        for (let c = 0; c < k; c++) values[ai].push((values[ai][a * k + c] + values[ai][b * k + c]) / 2);
      });
    }
    return m;
  };
  const out: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t];
    const b = index[t + 1];
    const c = index[t + 2];
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const g = new THREE.BufferGeometry();
  names.forEach((name, ai) => {
    const arr = new Float32Array(values[ai]);
    if (name === 'normal') {
      for (let i = 0; i < arr.length; i += 3) {
        const l = Math.hypot(arr[i], arr[i + 1], arr[i + 2]) || 1;
        arr[i] /= l;
        arr[i + 1] /= l;
        arr[i + 2] /= l;
      }
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, src[ai].itemSize));
  });
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
  return g;
}

/**
 * The vertices groom maps are painted on: the render mesh's vertices with UV-seam copies welded into one, so a
 * painted value is continuous across seams. Positions are in model space.
 */
export interface PaintMesh {
  /** Paint vertex of each render vertex. */
  weld: Int32Array;
  count: number;
  positions: Float32Array;
  normals: Float32Array;
  /** Neighbours of paint vertex i: neighbors[neighborStart[i] … neighborStart[i + 1]). */
  neighborStart: Uint32Array;
  neighbors: Uint32Array;
  /** Paint vertex nearest to each one's reflection about the midline (x = midlineX). */
  mirror: Int32Array;
  hash: SpatialHash;
}

/**
 * Builds the paint mesh of an indexed render geometry in model space. Normals are welded across seams.
 * `cell` sizes the vertex hash (about a typical brush radius, model units).
 */
export function buildPaintMesh(geometry: THREE.BufferGeometry, midlineX: number, cell: number): PaintMesh {
  const pos = geometry.getAttribute('position');
  const renderPositions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) renderPositions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
  const index = geometry.index!.array;
  const { groupOf: weld, count } = weldGroups(renderPositions);
  const renderNormals = weldedNormals(renderPositions, index);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions.set(renderPositions.subarray(i * 3, i * 3 + 3), weld[i] * 3);
    normals.set(renderNormals.subarray(i * 3, i * 3 + 3), weld[i] * 3);
  }

  // Edges between paint vertices (each once per direction), as compressed rows.
  const edgeSet = new Set<number>();
  for (let t = 0; t < index.length; t += 3) {
    const v = [weld[index[t]], weld[index[t + 1]], weld[index[t + 2]]];
    for (let k = 0; k < 3; k++) {
      const p = v[k];
      const q = v[(k + 1) % 3];
      if (p !== q) {
        edgeSet.add(p * count + q);
        edgeSet.add(q * count + p);
      }
    }
  }
  const neighborStart = new Uint32Array(count + 1);
  for (const e of edgeSet) neighborStart[Math.floor(e / count) + 1]++;
  for (let i = 0; i < count; i++) neighborStart[i + 1] += neighborStart[i];
  const fill = neighborStart.slice(0, count);
  const neighbors = new Uint32Array(edgeSet.size);
  for (const e of edgeSet) neighbors[fill[Math.floor(e / count)]++] = e % count;

  const hash = new SpatialHash(cell, count);
  for (let i = 0; i < count; i++) hash.insert(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const mirror = new Int32Array(count);
  for (let i = 0; i < count; i++)
    mirror[i] = nearestVertex(
      hash,
      2 * midlineX - positions[i * 3],
      positions[i * 3 + 1],
      positions[i * 3 + 2],
      normals,
      -normals[i * 3],
      normals[i * 3 + 1],
      normals[i * 3 + 2],
    );
  return { weld, count, positions, normals, neighborStart, neighbors, mirror, hash };
}

/**
 * The hashed vertex nearest to (x, y, z) whose normal faces within ~85° of (nx, ny, nz) (so a point on one face of
 * an ear doesn't pick the other face), widening the search ring until one is found; −1 if none.
 */
export function nearestVertex(
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  normals: Float32Array,
  nx: number,
  ny: number,
  nz: number,
): number {
  let best = -1;
  let bestD2 = Infinity;
  const visit = (id: number, d2: number) => {
    if (d2 >= bestD2) return;
    if (normals[id * 3] * nx + normals[id * 3 + 1] * ny + normals[id * 3 + 2] * nz < 0.1) return;
    best = id;
    bestD2 = d2;
  };
  for (let ring = 1; ring <= 8 && best < 0; ring *= 2) hash.forEachNear(x, y, z, ring, visit);
  return best;
}
