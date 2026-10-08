import * as THREE from 'three/webgpu';

import type { Rng } from '../../util/rng';
import type { GrowthMesh, SurfacePoint } from './types';

const faceA = new THREE.Vector3();
const faceB = new THREE.Vector3();
const faceC = new THREE.Vector3();

/** Area-weighted (optionally re-weighted) triangle sampling with barycentric output. */
export class SurfaceSampler {
  readonly areas: Float32Array;
  private cdf: Float64Array;
  private total = 0;

  readonly mesh: GrowthMesh;

  constructor(mesh: GrowthMesh) {
    this.mesh = mesh;
    const { positions: p, indices: idx, triangleCount } = mesh;
    this.areas = new Float32Array(triangleCount);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let t = 0; t < triangleCount; t++) {
      a.fromArray(p, idx[t * 3] * 3);
      b.fromArray(p, idx[t * 3 + 1] * 3);
      c.fromArray(p, idx[t * 3 + 2] * 3);
      b.sub(a);
      c.sub(a);
      this.areas[t] = b.cross(c).length() * 0.5;
    }
    this.cdf = new Float64Array(triangleCount);
    this.setWeights(null);
  }

  /** Re-weights triangles (e.g. by density mask at the centroid); null = pure area weighting. */
  setWeights(weight: ((tri: number) => number) | null): void {
    let acc = 0;
    for (let t = 0; t < this.areas.length; t++) {
      acc += this.areas[t] * (weight ? Math.max(0, weight(t)) : 1);
      this.cdf[t] = acc;
    }
    this.total = acc;
  }

  get totalWeightedArea(): number {
    return this.total;
  }

  /** Picks a triangle proportional to weighted area and a uniform point inside it. */
  sample(rng: Rng, out: SurfacePoint): boolean {
    if (this.total <= 0) return false;
    const r = rng.next() * this.total;
    let lo = 0;
    let hi = this.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const s = Math.sqrt(rng.next());
    const r2 = rng.next();
    this.evaluate(lo, 1 - s, s * (1 - r2), s * r2, out);
    return true;
  }

  /** Fills a SurfacePoint for triangle `tri` at barycentrics (u, v, w). */
  evaluate(tri: number, u: number, v: number, w: number, out: SurfacePoint): SurfacePoint {
    const { positions: p, normals: n, uvs, indices: idx, skinIndex, skinWeight } = this.mesh;
    const i0 = idx[tri * 3];
    const i1 = idx[tri * 3 + 1];
    const i2 = idx[tri * 3 + 2];
    out.tri = tri;
    out.u = u;
    out.v = v;
    out.w = w;
    out.position.set(
      p[i0 * 3] * u + p[i1 * 3] * v + p[i2 * 3] * w,
      p[i0 * 3 + 1] * u + p[i1 * 3 + 1] * v + p[i2 * 3 + 1] * w,
      p[i0 * 3 + 2] * u + p[i1 * 3 + 2] * v + p[i2 * 3 + 2] * w,
    );
    out.normal
      .set(
        n[i0 * 3] * u + n[i1 * 3] * v + n[i2 * 3] * w,
        n[i0 * 3 + 1] * u + n[i1 * 3 + 1] * v + n[i2 * 3 + 1] * w,
        n[i0 * 3 + 2] * u + n[i1 * 3 + 2] * v + n[i2 * 3 + 2] * w,
      )
      .normalize();
    // Thin features (ears): welded vertex normals cancel — use the face normal instead.
    faceA.fromArray(p, i0 * 3);
    faceB.fromArray(p, i1 * 3).sub(faceA);
    faceC.fromArray(p, i2 * 3).sub(faceA);
    faceB.cross(faceC).normalize();
    if (faceB.lengthSq() > 0 && out.normal.dot(faceB) < 0.3) out.normal.copy(faceB);
    if (uvs) {
      out.uv ??= new THREE.Vector2();
      out.uv.set(
        uvs[i0 * 2] * u + uvs[i1 * 2] * v + uvs[i2 * 2] * w,
        uvs[i0 * 2 + 1] * u + uvs[i1 * 2 + 1] * v + uvs[i2 * 2 + 1] * w,
      );
    } else {
      out.uv = null;
    }
    if (skinIndex && skinWeight) {
      const bones = out.bones ?? new Map<number, number>();
      bones.clear();
      const corners: [number, number][] = [
        [i0, u],
        [i1, v],
        [i2, w],
      ];
      for (const [vi, bw] of corners) {
        for (let k = 0; k < 4; k++) {
          const wt = skinWeight[vi * 4 + k] * bw;
          if (wt <= 0) continue;
          const bone = skinIndex[vi * 4 + k];
          bones.set(bone, (bones.get(bone) ?? 0) + wt);
        }
      }
      out.bones = bones;
    } else {
      out.bones = null;
    }
    return out;
  }
}

export function createSurfacePoint(): SurfacePoint {
  return {
    tri: 0,
    u: 1,
    v: 0,
    w: 0,
    position: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    uv: null,
    bones: null,
  };
}

export function copySurfacePoint(src: SurfacePoint, dst: SurfacePoint): SurfacePoint {
  dst.tri = src.tri;
  dst.u = src.u;
  dst.v = src.v;
  dst.w = src.w;
  dst.position.copy(src.position);
  dst.normal.copy(src.normal);
  dst.uv = src.uv ? (dst.uv ?? new THREE.Vector2()).copy(src.uv) : null;
  dst.bones = src.bones ? new Map(src.bones) : null;
  return dst;
}
