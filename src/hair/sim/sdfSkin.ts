import * as THREE from 'three/webgpu';

import type { SdfGrid } from '../sdf';
import { tsl } from './tsl';
import type { N } from './tslUtil';

const {
  Fn,
  If,
  Loop,
  buffer,
  clamp,
  float,
  floor,
  fract,
  instanceIndex,
  instancedArray,
  int,
  ivec3,
  max,
  mix,
  uint,
  uniform,
  vec3,
  vec4,
} = tsl;

/** Fixed-point iterations per frame; warm-started from the previous frame's preimage. */
const ITERATIONS = 4;
/** Relaxation of each iteration (stable where the skin weights change quickly). */
const RELAX = 0.7;

/**
 * Keeps a baked mesh SDF in step with linear-blend skinning. Every frame, cells near skin that isn't rigid with
 * the SDF's object are refreshed by inverse skinning: a warm-started fixed-point iteration finds the rest-pose
 * point the current pose moves onto the cell, and the cell takes the rest-pose distance there.
 * The skinning of a rest-pose point comes from either:
 * - dense `grid.weights`: up to 4 bones, interpolated from the closest triangle. Bone 0 must be rigid with the
 *   SDF's object; only cells near other bones are refreshed.
 * - per-vertex `grid.vertex`: any number of bones, from each cell's closest vertex. A first pass stores every
 *   cell's skinning map and the refresh blends the 8 surrounding maps trilinearly; every cell near the skin is
 *   refreshed.
 */
export class SkinnedSdf {
  /** Dispatched in order every frame (per-vertex mode: per-cell skinning matrices, then the refresh). */
  readonly kernels: N[];
  readonly cellCount: number;

  private readonly mesh: THREE.SkinnedMesh;

  /**
   * @param target read-write storage view of the SDF buffer the solver samples
   * @param padding how far (local units) the skin can move; widens the refreshed region
   */
  constructor(grid: SdfGrid, mesh: THREE.SkinnedMesh, target: N, padding: number) {
    this.mesh = mesh;
    const { nx, ny, nz, cell } = grid;
    const weights = grid.weights;
    const perVertex = !!grid.vertex;
    if (!weights && !perVertex)
      throw new Error('SkinnedSdf needs an SDF baked with skin weights or closest vertices');
    const boneCount = mesh.skeleton.bones.length;
    if (!perVertex && boneCount > 4) throw new Error('SkinnedSdf with dense weights supports up to 4 bones');

    // Refresh the cells near skin that isn't bound fully to bone 0 (every cell near the skin when the
    // skinning comes per vertex), plus the padding. Cells outside the narrow band (|d| = band) only carry
    // flood-filled skinning, so they don't count.
    let band = 0;
    for (let i = 0; i < grid.data.length; i++) band = Math.max(band, Math.abs(grid.data[i]));
    let lo = [nx, ny, nz];
    let hi = [-1, -1, -1];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = (k * ny + j) * nx + i;
          const c = idx * 4;
          if (Math.abs(grid.data[idx]) >= band * 0.999) continue;
          if (weights && !perVertex && weights[c + 1] + weights[c + 2] + weights[c + 3] < 1e-3) continue;
          lo = [Math.min(lo[0], i), Math.min(lo[1], j), Math.min(lo[2], k)];
          hi = [Math.max(hi[0], i), Math.max(hi[1], j), Math.max(hi[2], k)];
        }
    const pad = Number.isFinite(padding) ? Math.ceil(padding / cell) : Math.max(nx, ny, nz);
    const dims = [nx, ny, nz];
    lo = lo.map((v) => Math.max(0, v - pad));
    hi = hi.map((v, a) => Math.min(dims[a] - 1, v + pad));
    const size = hi.map((v, a) => Math.max(0, v - lo[a] + 1));
    const count = size[0] * size[1] * size[2];
    this.cellCount = count;

    // Rest-space preimage per refreshed cell, starting at the cell centres (exact in the rest pose).
    const pre0 = new Float32Array(Math.max(1, count) * 4);
    for (let k = 0; k < size[2]; k++)
      for (let j = 0; j < size[1]; j++)
        for (let i = 0; i < size[0]; i++) {
          const o = ((k * size[1] + j) * size[0] + i) * 4;
          pre0[o] = grid.min.x + (lo[0] + i + 0.5) * cell;
          pre0[o + 1] = grid.min.y + (lo[1] + j + 0.5) * cell;
          pre0[o + 2] = grid.min.z + (lo[2] + k + 0.5) * cell;
        }
    const pre = instancedArray(pre0, 'vec4') as N;
    const rest = instancedArray(grid.data.slice(), 'float').toReadOnly() as N;
    const bones = buffer(mesh.skeleton.boneMatrices, 'mat4', boneCount) as N;
    const bindMatrix = uniform(mesh.bindMatrix) as N;
    const bindMatrixInverse = uniform(mesh.bindMatrixInverse) as N;
    const gridMin = vec3(grid.min.x, grid.min.y, grid.min.z);
    const maxStep = 0.01 / mesh.matrixWorld.getMaxScaleOnAxis();
    const maxCoord = vec3(nx - 1.001, ny - 1.001, nz - 1.001);

    // Cell-centred grid coordinate of a local point, clamped so all 8 taps stay inside.
    const toGrid = (x: N) => clamp(x.sub(gridMin).div(cell).sub(0.5), vec3(0), maxCoord);
    const trilinear = (buf: N, g: N): N => {
      const i0 = ivec3(floor(g));
      const f = fract(g);
      const at = (dx: number, dy: number, dz: number) =>
        buf.element(i0.z.add(dz).mul(ny).add(i0.y.add(dy)).mul(nx).add(i0.x.add(dx)));
      const y0 = mix(mix(at(0, 0, 0), at(1, 0, 0), f.x), mix(at(0, 1, 0), at(1, 1, 0), f.x), f.y);
      const y1 = mix(mix(at(0, 0, 1), at(1, 0, 1), f.x), mix(at(0, 1, 1), at(1, 1, 1), f.x), f.y);
      return mix(y0, y1, f.z);
    };

    /** Where the current pose moves a rest-space point (mesh-local units). */
    let moveAt: (x: N) => N;
    let skinMatrices: N = null;
    if (perVertex) {
      // Joints and weights of each cell's closest vertex.
      const si = mesh.geometry.getAttribute('skinIndex');
      const sw = mesh.geometry.getAttribute('skinWeight');
      const total = nx * ny * nz;
      const joints = new Uint32Array(total * 4);
      const jw = new Float32Array(total * 4);
      for (let idx = 0; idx < total; idx++) {
        const v = grid.vertex![idx];
        if (v < 0) {
          jw[idx * 4] = 1;
          continue;
        }
        for (let k = 0; k < 4; k++) {
          joints[idx * 4 + k] = Math.min(boneCount - 1, si.getComponent(v, k));
          jw[idx * 4 + k] = sw.getComponent(v, k);
        }
      }
      const jointBuf = instancedArray(joints, 'uvec4').toReadOnly() as N;
      const weightBuf = instancedArray(jw, 'vec4').toReadOnly() as N;
      // Each frame, every cell's skinning (bind⁻¹ · Σ w·bone · bind) is stored as the 3 rows of an affine map.
      const rows = instancedArray(total * 3, 'vec4') as N;
      skinMatrices = (
        Fn(() => {
          const c = instanceIndex;
          If(c.lessThan(uint(total)), () => {
            const j = jointBuf.element(c);
            const w = weightBuf.element(c);
            const skin = bones
              .element(j.x)
              .mul(w.x)
              .add(bones.element(j.y).mul(w.y))
              .add(bones.element(j.z).mul(w.z))
              .add(bones.element(j.w).mul(w.w))
              .mul(float(1).div(max(w.x.add(w.y).add(w.z).add(w.w), 1e-6)));
            const m = bindMatrixInverse.mul(skin).mul(bindMatrix).toVar();
            const c0 = m.element(0);
            const c1 = m.element(1);
            const c2 = m.element(2);
            const c3 = m.element(3);
            const o = c.mul(3);
            rows.element(o).assign(vec4(c0.x, c1.x, c2.x, c3.x));
            rows.element(o.add(1)).assign(vec4(c0.y, c1.y, c2.y, c3.y));
            rows.element(o.add(2)).assign(vec4(c0.z, c1.z, c2.z, c3.z));
          });
        }) as N
      )()
        .compute(Math.max(1, total), [64])
        .setName('hair.sdf.skinMatrices');
      // The 8 surrounding cells' maps are blended trilinearly: a continuous skinning field, so the
      // fixed-point iteration settles instead of flipping between neighbouring cells' bones every frame.
      moveAt = (x: N) => {
        const g = toGrid(x);
        const i0 = ivec3(floor(g));
        const f = fract(g);
        const x1 = vec4(x, 1);
        const row = (r: number) => {
          const at = (dx: number, dy: number, dz: number) =>
            rows.element(i0.z.add(dz).mul(ny).add(i0.y.add(dy)).mul(nx).add(i0.x.add(dx)).mul(3).add(r));
          const y0 = mix(mix(at(0, 0, 0), at(1, 0, 0), f.x), mix(at(0, 1, 0), at(1, 1, 0), f.x), f.y);
          const y1 = mix(mix(at(0, 0, 1), at(1, 0, 1), f.x), mix(at(0, 1, 1), at(1, 1, 1), f.x), f.y);
          return mix(y0, y1, f.z);
        };
        return vec3(row(0).dot(x1), row(1).dot(x1), row(2).dot(x1));
      };
    } else {
      const wts = instancedArray(weights!, 'vec4').toReadOnly() as N;
      moveAt = (x: N) => {
        const w = trilinear(wts, toGrid(x));
        const wb = [w.x, w.y, w.z, w.w];
        let skin: N = bones.element(0).mul(wb[0]);
        for (let b = 1; b < boneCount; b++) skin = skin.add(bones.element(b).mul(wb[b]));
        skin = skin.mul(float(1).div(max(w.x.add(w.y).add(w.z).add(w.w), 1e-6)));
        return bindMatrixInverse.mul(skin).mul(bindMatrix).mul(vec4(x, 1)).xyz;
      };
    }

    const refresh = (
      Fn(() => {
        const id = instanceIndex;
        If(id.lessThan(uint(count)), () => {
          const li = int(id);
          const gi = ivec3(li.mod(size[0]), li.div(size[0]).mod(size[1]), li.div(size[0] * size[1])).add(
            ivec3(lo[0], lo[1], lo[2]),
          );
          const p = vec3(gi).add(0.5).mul(cell).add(gridMin);
          const x = pre.element(id).xyz.toVar();
          Loop(ITERATIONS, () => {
            x.subAssign(moveAt(x).sub(p).mul(RELAX));
          });
          pre.element(id).assign(vec4(x, 0));
          // A cell's distance changes by at most ~1 cm (world) per frame, so where the skin folds (armpits) and
          // inverse skinning can jump between solutions, the field eases over instead of flickering.
          const slot = target.element(gi.z.mul(ny).add(gi.y).mul(nx).add(gi.x));
          const old = float(slot).toVar();
          slot.assign(old.add(clamp(float(trilinear(rest, toGrid(x))).sub(old), -maxStep, maxStep)));
        });
      }) as N
    )()
      .compute(Math.max(1, count), [64])
      .setName('hair.sdf.skin');
    this.kernels = skinMatrices ? [skinMatrices, refresh] : [refresh];
  }

  /** Brings the bone matrices up to date before the dispatch. */
  prepare(): void {
    this.mesh.updateWorldMatrix(true, true);
    this.mesh.skeleton.update();
  }
}
