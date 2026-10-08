import { storage, uniform, uniformArray } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { sampleSdf, type SdfGrid } from './sdf';
import { SkinnedSdf } from './sim/sdfSkin';

export interface CapsuleDef {
  name: string;
  /** Endpoints in the attachment's local space (or world if attach is null). */
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** World units: not scaled by the attachment's transform. */
  radius: number;
  attach: THREE.Object3D | null;
}

export type ShapeKind = 'none' | 'sphere' | 'torus' | 'box';

export const SHAPE_IDS: Record<ShapeKind, number> = { none: 0, sphere: 1, torus: 2, box: 3 };

export interface ShapeDef {
  kind: ShapeKind;
  /** sphere: (r); torus: (R, r); box: (hx, hy, hz, rounding). */
  params: THREE.Vector4;
  attach: THREE.Object3D | null;
}

export const MAX_CAPSULES = 48;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

/**
 * Capsule colliders attached to bones/objects, plus one optional analytic shape and one optional baked
 * mesh SDF. Current and previous-frame transforms are kept so the solver can interpolate colliders across
 * substeps and compute collider velocity.
 */
export class ColliderSet {
  readonly capsules: CapsuleDef[] = [];
  shape: ShapeDef = { kind: 'none', params: new THREE.Vector4(), attach: null };
  /** Global radius multiplier (GUI). */
  radiusScale = 1;

  /** World-space capsules, 2 vec4 each: (a, radius), (b, 0). */
  private readonly currData = Array.from({ length: MAX_CAPSULES * 2 }, () => new THREE.Vector4());
  private readonly prevData = Array.from({ length: MAX_CAPSULES * 2 }, () => new THREE.Vector4());
  readonly currNode = uniformArray(this.currData, 'vec4');
  readonly prevNode = uniformArray(this.prevData, 'vec4');
  readonly count = uniform(0, 'uint');

  readonly shapeKind = uniform(0, 'uint');
  readonly shapeParams = uniform(new THREE.Vector4());
  readonly shapeInvCurr = uniform(new THREE.Matrix4());
  readonly shapeMatCurr = uniform(new THREE.Matrix4());
  readonly shapeInvPrev = uniform(new THREE.Matrix4());

  /** Optional baked mesh SDF (local units of `attach`), e.g. a character's torso. */
  sdf: { grid: SdfGrid; attach: THREE.Object3D; buffer: unknown } | null = null;
  /** Per-frame GPU refresh of the SDF where the skin is skinned to moving bones (see SkinnedSdf). */
  sdfSkin: SkinnedSdf | null = null;
  readonly sdfWorldToGrid = uniform(new THREE.Matrix4());
  readonly sdfLocalToWorld = uniform(new THREE.Matrix4());
  readonly sdfWorldToLocalPrev = uniform(new THREE.Matrix4());
  readonly sdfDims = uniform(new THREE.Vector3(2, 2, 2));
  /** Local distance units → meters (assumes uniform scale). */
  readonly sdfScale = uniform(1);
  /** The SDF's narrow band (local units): cells further away only know their sign. */
  readonly sdfBand = uniform(1);
  private readonly sdfWorldToLocal = new THREE.Matrix4();

  private initialized = false;

  /**
   * Attaches a baked SDF; must be set before hair kernels are built. With `skin` (the grid needs skin
   * weights or closest vertices), cells near skin bound to moving bones follow the skinning every frame;
   * `padding` is how far (local units) that skin can move.
   */
  setSdf(grid: SdfGrid, attach: THREE.Object3D, skin?: { mesh: THREE.SkinnedMesh; padding: number }): void {
    const attr = new THREE.StorageInstancedBufferAttribute(grid.data, 1);
    this.sdf = { grid, attach, buffer: storage(attr, 'float', attr.count).toReadOnly() };
    this.sdfSkin = skin
      ? new SkinnedSdf(grid, skin.mesh, storage(attr, 'float', attr.count), skin.padding)
      : null;
    this.sdfDims.value.set(grid.nx, grid.ny, grid.nz);
    let band = 0;
    for (let i = 0; i < grid.data.length; i++) band = Math.max(band, Math.abs(grid.data[i]));
    this.sdfBand.value = band;
  }

  add(def: CapsuleDef): this {
    if (this.capsules.length >= MAX_CAPSULES) throw new Error('Too many capsule colliders');
    this.capsules.push(def);
    return this;
  }

  addSphere(name: string, center: THREE.Vector3, radius: number, attach: THREE.Object3D | null): this {
    return this.add({ name, a: center.clone(), b: center.clone(), radius, attach });
  }

  setShape(kind: ShapeKind, params: THREE.Vector4, attach: THREE.Object3D | null): void {
    this.shape = { kind, params: params.clone(), attach };
  }

  /** World endpoints of capsule i (current transforms). Returns the effective radius. */
  worldCapsule(i: number, outA: THREE.Vector3, outB: THREE.Vector3): number {
    const c = this.capsules[i];
    outA.copy(c.a);
    outB.copy(c.b);
    if (c.attach) {
      outA.applyMatrix4(c.attach.matrixWorld);
      outB.applyMatrix4(c.attach.matrixWorld);
    }
    return c.radius * this.radiusScale;
  }

  /** Copies current → previous and recomputes current from attachment transforms. */
  update(reset = false): void {
    const n = this.capsules.length;
    for (let i = 0; i < n; i++) {
      const r = this.worldCapsule(i, tmpA, tmpB);
      this.prevData[i * 2].copy(this.currData[i * 2]);
      this.prevData[i * 2 + 1].copy(this.currData[i * 2 + 1]);
      this.currData[i * 2].set(tmpA.x, tmpA.y, tmpA.z, r);
      this.currData[i * 2 + 1].set(tmpB.x, tmpB.y, tmpB.z, 0);
      if (reset || !this.initialized) {
        this.prevData[i * 2].copy(this.currData[i * 2]);
        this.prevData[i * 2 + 1].copy(this.currData[i * 2 + 1]);
      }
    }
    this.count.value = n;

    const s = this.shape;
    this.shapeKind.value = SHAPE_IDS[s.kind];
    this.shapeParams.value.copy(s.params);
    this.shapeInvPrev.value.copy(this.shapeInvCurr.value);
    const m = s.attach ? s.attach.matrixWorld : tmpM.identity();
    this.shapeMatCurr.value.copy(m);
    this.shapeInvCurr.value.copy(m).invert();
    if (reset || !this.initialized) this.shapeInvPrev.value.copy(this.shapeInvCurr.value);

    if (this.sdf) {
      const { grid, attach } = this.sdf;
      this.sdfWorldToLocalPrev.value.copy(this.sdfWorldToLocal);
      this.sdfLocalToWorld.value.copy(attach.matrixWorld);
      this.sdfWorldToLocal.copy(attach.matrixWorld).invert();
      if (reset || !this.initialized) this.sdfWorldToLocalPrev.value.copy(this.sdfWorldToLocal);
      // grid coords (cell-centred): (local − (min + cell/2)) / cell
      const toGrid = new THREE.Matrix4()
        .makeScale(1 / grid.cell, 1 / grid.cell, 1 / grid.cell)
        .multiply(
          new THREE.Matrix4().makeTranslation(
            -(grid.min.x + grid.cell / 2),
            -(grid.min.y + grid.cell / 2),
            -(grid.min.z + grid.cell / 2),
          ),
        );
      this.sdfWorldToGrid.value.multiplyMatrices(toGrid, this.sdfWorldToLocal);
      this.sdfScale.value = attach.matrixWorld.getMaxScaleOnAxis();
    }
    this.initialized = true;
  }

  /** CPU signed distance (meters) to the baked SDF; writes the outward world normal. */
  sdfDistance(p: THREE.Vector3, outNormal?: THREE.Vector3): number {
    if (!this.sdf) return Infinity;
    const { grid, attach } = this.sdf;
    const inv = new THREE.Matrix4().copy(attach.matrixWorld).invert();
    const q = p.clone().applyMatrix4(inv);
    const grad = new THREE.Vector3();
    const d = sampleSdf(grid, q, grad);
    if (!Number.isFinite(d)) return Infinity;
    if (outNormal) outNormal.copy(grad).transformDirection(attach.matrixWorld);
    return d * attach.matrixWorld.getMaxScaleOnAxis();
  }

  /** CPU signed distance to capsule i (current transforms). */
  capsuleDistance(i: number, p: THREE.Vector3): number {
    const r = this.worldCapsule(i, tmpA, tmpB);
    return closestOnSegment(p, tmpA, tmpB, tmpP).distanceTo(p) - r;
  }

  /** CPU signed distance to the analytic shape (current transform). */
  shapeDistance(p: THREE.Vector3, outNormal?: THREE.Vector3): number {
    const s = this.shape;
    if (s.kind === 'none') return Infinity;
    const m = s.attach ? s.attach.matrixWorld : tmpM.identity();
    const inv = tmpM.copy(m).invert();
    const q = tmpP.copy(p).applyMatrix4(inv);
    const d = shapeSdf(s.kind, s.params, q);
    if (outNormal) {
      const e = 1e-4;
      const g = new THREE.Vector3(
        shapeSdf(s.kind, s.params, q.clone().setX(q.x + e)) -
          shapeSdf(s.kind, s.params, q.clone().setX(q.x - e)),
        shapeSdf(s.kind, s.params, q.clone().setY(q.y + e)) -
          shapeSdf(s.kind, s.params, q.clone().setY(q.y - e)),
        shapeSdf(s.kind, s.params, q.clone().setZ(q.z + e)) -
          shapeSdf(s.kind, s.params, q.clone().setZ(q.z - e)),
      );
      outNormal.copy(g.transformDirection(m));
    }
    return d;
  }

  /**
   * Pushes `p` out of all enabled capsules (bitmask) and the shape, by `margin`.
   * Used at groom time. Returns true if moved.
   */
  pushOut(p: THREE.Vector3, mask: number, margin: number): boolean {
    let moved = false;
    for (let i = 0; i < this.capsules.length; i++) {
      if (i < 32 && (mask & (1 << i)) === 0) continue;
      const r = this.worldCapsule(i, tmpA, tmpB) + margin;
      const c = closestOnSegment(p, tmpA, tmpB, tmpP);
      const d = p.distanceTo(c);
      if (d < r) {
        const dir = d > 1e-7 ? p.clone().sub(c).divideScalar(d) : new THREE.Vector3(0, 1, 0);
        p.copy(c).addScaledVector(dir, r);
        moved = true;
      }
    }
    if (this.shape.kind !== 'none') {
      const n = new THREE.Vector3();
      const d = this.shapeDistance(p, n);
      if (d < margin && n.lengthSq() > 0) {
        p.addScaledVector(n.normalize(), margin - d);
        moved = true;
      }
    }
    if (this.sdf) {
      const n = new THREE.Vector3();
      const d = this.sdfDistance(p, n);
      if (d < margin && n.lengthSq() > 0) {
        p.addScaledVector(n.normalize(), margin - d);
        moved = true;
      }
    }
    return moved;
  }
}

export function closestOnSegment(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-12)
    t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2));
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}

export function shapeSdf(kind: ShapeKind, params: THREE.Vector4, q: THREE.Vector3): number {
  switch (kind) {
    case 'sphere':
      return q.length() - params.x;
    case 'torus': {
      const qx = Math.hypot(q.x, q.z) - params.x;
      return Math.hypot(qx, q.y) - params.y;
    }
    case 'box': {
      const r = params.w;
      const dx = Math.abs(q.x) - (params.x - r);
      const dy = Math.abs(q.y) - (params.y - r);
      const dz = Math.abs(q.z) - (params.z - r);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
      return outside + Math.min(Math.max(dx, dy, dz), 0) - r;
    }
    default:
      return Infinity;
  }
}
