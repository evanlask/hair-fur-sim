import * as THREE from 'three/webgpu';

/** A signed distance field sampled at cell centres of a regular grid (model/local units). */
export interface SdfGrid {
  data: Float32Array;
  nx: number;
  ny: number;
  nz: number;
  /** Grid min corner (local units). */
  min: THREE.Vector3;
  /** Cell size (local units). */
  cell: number;
  /** Optional per-cell vec4 interpolated from the closest triangle (e.g. dense skin weights). */
  weights?: Float32Array;
  /** Optional per-cell index of the closest vertex (e.g. to look up its skinning). */
  vertex?: Int32Array;
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const ab = new THREE.Vector3();
const ac = new THREE.Vector3();
const ap = new THREE.Vector3();
const bp = new THREE.Vector3();
const cp = new THREE.Vector3();

/**
 * Closest point on triangle (Ericson, Real-Time Collision Detection) + barycentrics. The triangle is
 * read from the module-level `a`, `b`, `c`, which the caller fills.
 */
function closestOnTriangle(p: THREE.Vector3, out: THREE.Vector3, bary: [number, number, number]): void {
  ab.subVectors(b, a);
  ac.subVectors(c, a);
  ap.subVectors(p, a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) {
    out.copy(a);
    bary[0] = 1;
    bary[1] = 0;
    bary[2] = 0;
    return;
  }
  bp.subVectors(p, b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) {
    out.copy(b);
    bary[0] = 0;
    bary[1] = 1;
    bary[2] = 0;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.copy(a).addScaledVector(ab, v);
    bary[0] = 1 - v;
    bary[1] = v;
    bary[2] = 0;
    return;
  }
  cp.subVectors(p, c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) {
    out.copy(c);
    bary[0] = 0;
    bary[1] = 0;
    bary[2] = 1;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.copy(a).addScaledVector(ac, w);
    bary[0] = 1 - w;
    bary[1] = 0;
    bary[2] = w;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out.copy(b).addScaledVector(c.clone().sub(b), w);
    bary[0] = 0;
    bary[1] = 1 - w;
    bary[2] = w;
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out.copy(a).addScaledVector(ab, v).addScaledVector(ac, w);
  bary[0] = 1 - v - w;
  bary[1] = v;
  bary[2] = w;
}

/**
 * Bakes a narrow-band SDF of a closed triangle mesh inside [min, max] (local units).
 * Distances within `band` are exact (closest triangle, sign from the interpolated vertex normal);
 * cells further away get ±band with the sign flood-filled from the band. An optional per-vertex vec4
 * `attribute` is interpolated at the closest point (and flood-filled the same way) into `weights`;
 * `closestVertex` records the vertex nearest to each cell's closest point (flood-filled too) in `vertex`.
 */
export function bakeMeshSdf(
  positions: Float32Array,
  normals: Float32Array,
  indices: ArrayLike<number>,
  min: THREE.Vector3,
  max: THREE.Vector3,
  cell: number,
  band: number,
  attribute?: Float32Array,
  closestVertex = false,
): SdfGrid {
  const nx = Math.max(2, Math.ceil((max.x - min.x) / cell));
  const ny = Math.max(2, Math.ceil((max.y - min.y) / cell));
  const nz = Math.max(2, Math.ceil((max.z - min.z) / cell));
  const data = new Float32Array(nx * ny * nz).fill(NaN);
  const weights = attribute ? new Float32Array(nx * ny * nz * 4) : undefined;
  const vertex = closestVertex ? new Int32Array(nx * ny * nz).fill(-1) : undefined;

  // Bucket triangles (expanded by the band) into a coarse grid aligned with the SDF, so each cell only
  // tests the triangles in its own bucket.
  const bucket = Math.max(band, cell * 2);
  const bx = Math.ceil((max.x - min.x) / bucket) + 1;
  const by = Math.ceil((max.y - min.y) / bucket) + 1;
  const bz = Math.ceil((max.z - min.z) / bucket) + 1;
  const buckets: number[][] = Array.from({ length: bx * by * bz }, () => []);
  const triCount = indices.length / 3;
  const lo = new THREE.Vector3();
  const hi = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    a.fromArray(positions, indices[t * 3] * 3);
    b.fromArray(positions, indices[t * 3 + 1] * 3);
    c.fromArray(positions, indices[t * 3 + 2] * 3);
    lo.copy(a).min(b).min(c).subScalar(band);
    hi.copy(a).max(b).max(c).addScalar(band);
    if (hi.x < min.x || hi.y < min.y || hi.z < min.z || lo.x > max.x || lo.y > max.y || lo.z > max.z)
      continue;
    const x0 = Math.max(0, Math.floor((lo.x - min.x) / bucket));
    const y0 = Math.max(0, Math.floor((lo.y - min.y) / bucket));
    const z0 = Math.max(0, Math.floor((lo.z - min.z) / bucket));
    const x1 = Math.min(bx - 1, Math.floor((hi.x - min.x) / bucket));
    const y1 = Math.min(by - 1, Math.floor((hi.y - min.y) / bucket));
    const z1 = Math.min(bz - 1, Math.floor((hi.z - min.z) / bucket));
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) buckets[(z * by + y) * bx + x].push(t);
  }

  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const best = new THREE.Vector3();
  const n = new THREE.Vector3();
  const bary: [number, number, number] = [0, 0, 0];
  const bestBary: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        p.set(min.x + (i + 0.5) * cell, min.y + (j + 0.5) * cell, min.z + (k + 0.5) * cell);
        const list =
          buckets[
            (Math.floor((p.z - min.z) / bucket) * by + Math.floor((p.y - min.y) / bucket)) * bx +
              Math.floor((p.x - min.x) / bucket)
          ];
        let bestD2 = band * band;
        let bestTri = -1;
        for (const t of list) {
          a.fromArray(positions, indices[t * 3] * 3);
          b.fromArray(positions, indices[t * 3 + 1] * 3);
          c.fromArray(positions, indices[t * 3 + 2] * 3);
          closestOnTriangle(p, q, bary);
          const d2 = q.distanceToSquared(p);
          if (d2 < bestD2) {
            bestD2 = d2;
            bestTri = t;
            best.copy(q);
            bestBary[0] = bary[0];
            bestBary[1] = bary[1];
            bestBary[2] = bary[2];
          }
        }
        if (bestTri < 0) continue;
        n.set(0, 0, 0);
        for (let v = 0; v < 3; v++) {
          const vi = indices[bestTri * 3 + v];
          n.x += normals[vi * 3] * bestBary[v];
          n.y += normals[vi * 3 + 1] * bestBary[v];
          n.z += normals[vi * 3 + 2] * bestBary[v];
        }
        const d = Math.sqrt(bestD2);
        const cellIdx = (k * ny + j) * nx + i;
        data[cellIdx] = p.sub(best).dot(n) >= 0 ? d : -d;
        if (vertex) {
          const v =
            bestBary[0] >= bestBary[1] && bestBary[0] >= bestBary[2] ? 0 : bestBary[1] >= bestBary[2] ? 1 : 2;
          vertex[cellIdx] = indices[bestTri * 3 + v];
        }
        if (weights && attribute) {
          for (let ch = 0; ch < 4; ch++) {
            let w = 0;
            for (let v = 0; v < 3; v++) w += attribute[indices[bestTri * 3 + v] * 4 + ch] * bestBary[v];
            weights[cellIdx * 4 + ch] = w;
          }
        }
      }

  // Flood-fill the sign of cells outside the band (NaN marks cells not reached yet).
  const queue: number[] = [];
  for (let idx = 0; idx < data.length; idx++) if (!Number.isNaN(data[idx])) queue.push(idx);
  for (let qi = 0; qi < queue.length; qi++) {
    const idx = queue[qi];
    const s = data[idx] >= 0 ? band : -band;
    const i = idx % nx;
    const j = Math.floor(idx / nx) % ny;
    const k = Math.floor(idx / (nx * ny));
    const visit = (ii: number, jj: number, kk: number) => {
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) return;
      const nidx = (kk * ny + jj) * nx + ii;
      if (Number.isNaN(data[nidx])) {
        data[nidx] = s;
        if (weights) weights.copyWithin(nidx * 4, idx * 4, idx * 4 + 4);
        if (vertex) vertex[nidx] = vertex[idx];
        queue.push(nidx);
      }
    };
    visit(i - 1, j, k);
    visit(i + 1, j, k);
    visit(i, j - 1, k);
    visit(i, j + 1, k);
    visit(i, j, k - 1);
    visit(i, j, k + 1);
  }
  for (let idx = 0; idx < data.length; idx++) if (Number.isNaN(data[idx])) data[idx] = band;
  return { data, nx, ny, nz, min: min.clone(), cell, weights, vertex };
}

/** CPU trilinear sample: local-unit distance (Infinity outside the grid); optionally writes the gradient. */
export function sampleSdf(g: SdfGrid, p: THREE.Vector3, grad?: THREE.Vector3): number {
  const u = (p.x - g.min.x) / g.cell - 0.5;
  const v = (p.y - g.min.y) / g.cell - 0.5;
  const w = (p.z - g.min.z) / g.cell - 0.5;
  if (u < 0 || v < 0 || w < 0 || u >= g.nx - 1 || v >= g.ny - 1 || w >= g.nz - 1) return Infinity;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const k = Math.floor(w);
  const fx = u - i;
  const fy = v - j;
  const fz = w - k;
  const at = (ii: number, jj: number, kk: number) => g.data[((k + kk) * g.ny + (j + jj)) * g.nx + (i + ii)];
  const c000 = at(0, 0, 0),
    c100 = at(1, 0, 0),
    c010 = at(0, 1, 0),
    c110 = at(1, 1, 0);
  const c001 = at(0, 0, 1),
    c101 = at(1, 0, 1),
    c011 = at(0, 1, 1),
    c111 = at(1, 1, 1);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  if (grad) {
    const dx0 = c100 - c000 + (c110 - c010 - (c100 - c000)) * fy;
    const dx1 = c101 - c001 + (c111 - c011 - (c101 - c001)) * fy;
    grad
      .set(dx0 + (dx1 - dx0) * fz, x10 - x00 + (x11 - x01 - (x10 - x00)) * fz, y1 - y0)
      .divideScalar(g.cell);
  }
  return y0 + (y1 - y0) * fz;
}
