import * as THREE from 'three/webgpu';

import type { PaintMesh } from './paintMesh';

/** How high gathered hair lies over the skin (m). */
const SKIN_GAP = 0.003;
/** Distance over which it gets back to that height (m). */
const SETTLE = 0.01;
/** Within this of the tie (m) it stops steering and goes on along its bend target (e.g. down a ponytail). */
const AT_TIE = 0.008;

/**
 * Growth steering for a layer gathered at a tie (LayerSettings.gather): each guide grows over the skin, SKIN_GAP
 * above it, straight for the tie (the way along the skin that points there), as a hair tie pulls hair. Called with
 * world positions in the bust's home pose; `tie` and the paint mesh are in model units (`scale` m each).
 */
export function gatherSteer(
  paint: PaintMesh,
  tie: THREE.Vector3,
  modelToWorld: THREE.Matrix4,
  scale: number,
): (position: THREE.Vector3, target: THREE.Vector3) => void {
  const toModel = modelToWorld.clone().invert();
  const toWorld = new THREE.Matrix3().setFromMatrix4(modelToWorld);
  const gap = SKIN_GAP / scale;
  const settle = SETTLE / scale;
  const reach = AT_TIE / scale;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const d = new THREE.Vector3();
  const { positions, normals, hash } = paint;
  return (position, target) => {
    p.copy(position).applyMatrix4(toModel);
    d.subVectors(tie, p);
    if (d.length() < reach) return;
    let nearest = -1;
    let best = Infinity;
    hash.forEachNear(p.x, p.y, p.z, 1, (id, d2) => {
      if (d2 < best) {
        best = d2;
        nearest = id;
      }
    });
    // Off the skin (more than a brush cell away): leave it be.
    if (nearest < 0) return;
    n.fromArray(normals, nearest * 3);
    const height =
      (p.x - positions[nearest * 3]) * n.x +
      (p.y - positions[nearest * 3 + 1]) * n.y +
      (p.z - positions[nearest * 3 + 2]) * n.z;
    d.addScaledVector(n, -d.dot(n));
    if (d.lengthSq() < 1e-12) return;
    d.normalize().addScaledVector(n, THREE.MathUtils.clamp((gap - height) / settle, -1, 1));
    target.copy(d).applyMatrix3(toWorld).normalize();
  };
}

/**
 * Distance (m) over the skin from every paint vertex to the tie: shortest paths along the mesh's edges (Dijkstra),
 * about the way gathered hair takes there (a few percent longer, which tucks the ends into the tie).
 */
export function gatherDistances(paint: PaintMesh, tie: THREE.Vector3, scale: number): Float32Array {
  const { count, positions: p, neighborStart, neighbors } = paint;
  let start = 0;
  let nearest = Infinity;
  for (let i = 0; i < count; i++) {
    const d = (p[i * 3] - tie.x) ** 2 + (p[i * 3 + 1] - tie.y) ** 2 + (p[i * 3 + 2] - tie.z) ** 2;
    if (d < nearest) {
      nearest = d;
      start = i;
    }
  }
  const dist = new Float32Array(count).fill(Infinity);
  const done = new Uint8Array(count);
  // Binary min-heap of vertices by distance (entries go stale when a vertex gets closer; skipped when popped).
  const heap: number[] = [];
  const keys: number[] = [];
  const push = (v: number, k: number) => {
    let i = heap.length;
    heap.push(v);
    keys.push(k);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= k) break;
      heap[i] = heap[up];
      keys[i] = keys[up];
      i = up;
    }
    heap[i] = v;
    keys[i] = k;
  };
  const pop = (): number => {
    const top = heap[0];
    const v = heap.pop()!;
    const k = keys.pop()!;
    if (heap.length) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        heap[i] = heap[c];
        keys[i] = keys[c];
        i = c;
      }
      heap[i] = v;
      keys[i] = k;
    }
    return top;
  };
  dist[start] = 0;
  push(start, 0);
  while (heap.length) {
    const v = pop();
    if (done[v]) continue;
    done[v] = 1;
    for (let j = neighborStart[v]; j < neighborStart[v + 1]; j++) {
      const u = neighbors[j];
      const d =
        dist[v] + Math.hypot(p[u * 3] - p[v * 3], p[u * 3 + 1] - p[v * 3 + 1], p[u * 3 + 2] - p[v * 3 + 2]);
      if (d < dist[u]) {
        dist[u] = d;
        push(u, d);
      }
    }
  }
  for (let i = 0; i < count; i++) dist[i] *= scale;
  return dist;
}
