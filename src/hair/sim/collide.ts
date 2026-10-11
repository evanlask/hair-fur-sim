import type { ColliderSet } from '../colliders';
import type { HairUniforms } from '../params';
import { tsl } from './tsl';
import { safeNormalize, type N } from './tslUtil';

const {
  Fn,
  If,
  Loop,
  abs,
  clamp,
  cross,
  dot,
  floor,
  fract,
  int,
  ivec3,
  length,
  max,
  min,
  mix,
  select,
  smoothstep,
  uint,
  vec3,
  vec4,
} = tsl;

/**
 * Cells over which the baked mesh SDF's push fades in from the grid's bounds, so hair resting across an edge that
 * cuts through the skin (a torso SDF ending at the neck) isn't shoved out abruptly and left flicking.
 */
const SDF_EDGE_FADE = 1.5;

/**
 * Analytic SDF of the collider shape in its local space. Returns vec4(gradient.xyz, distance).
 * kind: 1 sphere (r), 2 torus (R, r), 3 rounded box (hx, hy, hz, rounding).
 */
export const shapeSdf = Fn(([q, kind, params]: [N, N, N]) => {
  const result = vec4(0, 1, 0, 1e9).toVar();
  If(kind.equal(uint(1)), () => {
    const l = length(q);
    result.assign(vec4(safeNormalize(q, vec3(0, 1, 0)), l.sub(params.x)));
  })
    .ElseIf(kind.equal(uint(2)), () => {
      const lxz = length(q.xz);
      const ring = vec3(q.x, 0, q.z).mul(params.x.div(max(lxz, 1e-6)));
      const d = q.sub(ring);
      result.assign(vec4(safeNormalize(d, vec3(0, 1, 0)), length(d).sub(params.y)));
    })
    .ElseIf(kind.equal(uint(3)), () => {
      const r = params.w;
      const p = abs(q).sub(params.xyz.sub(r));
      const outside = max(p, vec3(0));
      const lo = length(outside);
      const inside = min(max(p.x, max(p.y, p.z)), 0);
      const dist = lo.add(inside).sub(r);
      // Gradient: outside → direction of the clamped excess; inside → dominant axis.
      const axis = select(
        p.x.greaterThan(max(p.y, p.z)),
        vec3(1, 0, 0),
        select(p.y.greaterThan(p.z), vec3(0, 1, 0), vec3(0, 0, 1)),
      );
      const gOut = outside.div(max(lo, 1e-6));
      const sgn = vec3(
        select(q.x.lessThan(0), -1, 1),
        select(q.y.lessThan(0), -1, 1),
        select(q.z.lessThan(0), -1, 1),
      );
      const g = select(lo.greaterThan(1e-6), gOut, axis).mul(sgn);
      result.assign(vec4(safeNormalize(g, vec3(0, 1, 0)), dist));
    });
  return result;
}).setLayout({
  name: 'hairShapeSdf',
  type: 'vec4',
  inputs: [
    { name: 'q', type: 'vec3' },
    { name: 'kind', type: 'uint' },
    { name: 'params', type: 'vec4' },
  ],
});

export interface CollideResult {
  /** Pushed-out position. */
  x: N;
  /** Contact normal (zero if no contact). */
  normal: N;
  /** Collider displacement over the current substep at the contact (for friction). */
  disp: N;
}

/**
 * Pushes x out of the enabled capsules (bit i of `mask`; capsules ≥ 32 are always on), the analytic shape
 * and the baked mesh SDF.
 * `alpha` interpolates collider transforms between the previous and current frame;
 * `stepFrac` is the fraction of the frame covered by one substep.
 */
export function collide(
  colliders: ColliderSet,
  u: HairUniforms,
  xIn: N,
  mask: N,
  alpha: N,
  stepFrac: N,
  /** Largest push out of the mesh SDF per call (m); unlimited by default. */
  maxSdfPush = 1e3,
  /** Whether the mesh SDF applies to this point (e.g. not near the root, where skin folds onto the fur). */
  sdfOn: N = null,
): CollideResult {
  const x = vec3(xIn).toVar();
  const normal = vec3(0).toVar();
  const disp = vec3(0).toVar();
  const curr = colliders.currNode as N;
  const prev = colliders.prevNode as N;
  const margin = u.collisionMargin as N;

  Loop({ start: uint(0), end: colliders.count as N, type: 'uint', condition: '<' }, ({ i }: { i: N }) => {
    const enabled = i.greaterThanEqual(uint(32)).or(
      mask
        .shiftRight(min(i, uint(31)))
        .bitAnd(uint(1))
        .equal(uint(1)),
    );
    If(enabled, () => {
      const ca = curr.element(i.mul(2));
      const cb = curr.element(i.mul(2).add(1));
      const pa = prev.element(i.mul(2));
      const pb = prev.element(i.mul(2).add(1));
      const a = mix(pa.xyz, ca.xyz, alpha);
      const b = mix(pb.xyz, cb.xyz, alpha);
      const r = ca.w.add(margin);
      const ab = b.sub(a);
      const t = clamp(dot(x.sub(a), ab).div(max(dot(ab, ab), 1e-12)), 0, 1);
      const c = a.add(ab.mul(t));
      const d = x.sub(c);
      const dl = length(d);
      If(dl.lessThan(r), () => {
        // On the axis: push perpendicular to it. The 0.001 keeps vertical capsules from giving a zero cross.
        const n = safeNormalize(d, safeNormalize(cross(ab, vec3(0, 1, 0.001)), vec3(0, 1, 0)));
        x.assign(c.add(n.mul(r)));
        normal.assign(n);
        disp.assign(mix(ca.xyz.sub(pa.xyz), cb.xyz.sub(pb.xyz), t).mul(stepFrac));
      });
    });
  });

  If((colliders.shapeKind as N).notEqual(uint(0)), () => {
    const invCurr = colliders.shapeInvCurr as N;
    const invPrev = colliders.shapeInvPrev as N;
    const matCurr = colliders.shapeMatCurr as N;
    const qc = invCurr.mul(vec4(x, 1)).xyz;
    const qp = invPrev.mul(vec4(x, 1)).xyz;
    const q = mix(qp, qc, alpha);
    const s = shapeSdf(q, colliders.shapeKind, colliders.shapeParams);
    If(s.w.lessThan(margin), () => {
      const nWorld = safeNormalize(matCurr.mul(vec4(s.xyz, 0)).xyz, vec3(0, 1, 0));
      x.addAssign(nWorld.mul(margin.sub(s.w)));
      normal.assign(nWorld);
      // Collider motion at the contact: where the shape point under x a frame ago is now.
      const moved = matCurr.mul(vec4(qp, 1)).xyz;
      disp.assign(moved.sub(x).mul(stepFrac));
    });
  });

  if (colliders.sdf) {
    // Baked mesh SDF: trilinear distance, and the exact gradient of that interpolation from the same 8 taps.
    const sdf = colliders.sdf.buffer as N;
    const dims = colliders.sdfDims as N;
    const g = (colliders.sdfWorldToGrid as N).mul(vec4(x, 1)).xyz.toVar();
    const inside = g.x
      .greaterThanEqual(0)
      .and(g.y.greaterThanEqual(0))
      .and(g.z.greaterThanEqual(0))
      .and(g.x.lessThan(dims.x.sub(1)))
      .and(g.y.lessThan(dims.y.sub(1)))
      .and(g.z.lessThan(dims.z.sub(1)));
    If(inside, () => {
      const nx = int(dims.x);
      const ny = int(dims.y);
      const i0 = ivec3(floor(g));
      const f = fract(g);
      const at = (dx: number, dy: number, dz: number) =>
        sdf.element(i0.z.add(dz).mul(ny).add(i0.y.add(dy)).mul(nx).add(i0.x.add(dx)));
      const c000 = at(0, 0, 0);
      const c100 = at(1, 0, 0);
      const c010 = at(0, 1, 0);
      const c110 = at(1, 1, 0);
      const c001 = at(0, 0, 1);
      const c101 = at(1, 0, 1);
      const c011 = at(0, 1, 1);
      const c111 = at(1, 1, 1);
      const x00 = mix(c000, c100, f.x);
      const x10 = mix(c010, c110, f.x);
      const x01 = mix(c001, c101, f.x);
      const x11 = mix(c011, c111, f.x);
      const y0 = mix(x00, x10, f.y);
      const y1 = mix(x01, x11, f.y);
      const dLocal = mix(y0, y1, f.z);
      const dx0 = mix(c100.sub(c000), c110.sub(c010), f.y);
      const dx1 = mix(c101.sub(c001), c111.sub(c011), f.y);
      const grad = vec3(mix(dx0, dx1, f.z), mix(x10.sub(x00), x11.sub(x01), f.z), y1.sub(y0));
      const dWorld = dLocal.mul(colliders.sdfScale);
      // Deeper than the band the field only knows "inside", not which way is out: leave those to the capsules.
      const known = dLocal
        .greaterThan((colliders.sdfBand as N).mul(-0.95))
        .and(dot(grad, grad).greaterThan(1e-12));
      const apply = sdfOn ? known.and(sdfOn) : known;
      If(dWorld.lessThan(margin).and(apply), () => {
        const toWorld = colliders.sdfLocalToWorld as N;
        const nWorld = safeNormalize(toWorld.mul(vec4(grad, 0)).xyz, vec3(0, 1, 0));
        const far = dims.sub(1).sub(g);
        const toEdge = min(min(min(g.x, g.y), g.z), min(min(far.x, far.y), far.z));
        const fade = smoothstep(0, SDF_EDGE_FADE, toEdge);
        x.addAssign(nWorld.mul(min(margin.sub(dWorld), maxSdfPush).mul(fade)));
        normal.assign(nWorld);
        const prevLocal = (colliders.sdfWorldToLocalPrev as N).mul(vec4(x, 1));
        disp.assign(toWorld.mul(prevLocal).xyz.sub(x).mul(stepFrac));
      });
    });
  }

  return { x, normal, disp };
}
