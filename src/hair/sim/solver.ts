import { collide } from './collide';
import type { GroupContext } from './context';
import { tsl } from './tsl';
import {
  frameRotate,
  frameToLocal,
  frameToWorld,
  orthoFrame,
  rootNormal,
  rotateFromTo,
  safeNormalize,
  type N,
} from './tslUtil';

const {
  Fn,
  If,
  Loop,
  clamp,
  dot,
  float,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  mx_noise_vec3,
  pow,
  select,
  sin,
  uint,
  vec3,
  vec4,
} = tsl;

/** Number of pinned particles at the root (root + second particle → stable root tangent). */
const PIN = 2;

/**
 * Per guide: root position + smooth frame from the deformed triangle. The old frame moves to slots 3–5
 * so the solver can interpolate the root across substeps.
 */
export function buildRootsKernel(ctx: GroupContext): N {
  const { guideRootTri, guideRootBary, deformed, guideFrames: frames, u } = ctx;
  return (
    Fn(() => {
      const g = instanceIndex;
      const tri = guideRootTri.element(g);
      const bary = guideRootBary.element(g);
      const p0 = deformed.element(tri.x.mul(2)).xyz;
      const p1 = deformed.element(tri.y.mul(2)).xyz;
      const p2 = deformed.element(tri.z.mul(2)).xyz;
      const pos = p0.mul(bary.x).add(p1.mul(bary.y)).add(p2.mul(bary.z));
      // Smooth frame: interpolated vertex normal + first edge (matches the CPU groomer's smoothFrame).
      const nInterp = deformed
        .element(tri.x.mul(2).add(1))
        .xyz.mul(bary.x)
        .add(deformed.element(tri.y.mul(2).add(1)).xyz.mul(bary.y))
        .add(deformed.element(tri.z.mul(2).add(1)).xyz.mul(bary.z));
      const f = orthoFrame(p1.sub(p0), rootNormal(p0, p1, p2, nInterp));
      const n = f.n;
      const t = f.t;
      const base = g.mul(6);
      const oldP = frames.element(base).toVar();
      const oldT = frames.element(base.add(1)).toVar();
      const oldN = frames.element(base.add(2)).toVar();
      const first = (u.firstFrame as N).equal(uint(1));
      frames.element(base.add(3)).assign(select(first, vec4(pos, 1), oldP));
      frames.element(base.add(4)).assign(select(first, vec4(t, 0), oldT));
      frames.element(base.add(5)).assign(select(first, vec4(n, 0), oldN));
      frames.element(base).assign(vec4(pos, bary.w));
      frames.element(base.add(1)).assign(vec4(t, 0));
      frames.element(base.add(2)).assign(vec4(n, 0));
    }) as N
  )()
    .compute(ctx.Ng, [64])
    .setName('hair.roots');
}

/** Per particle: snap to the rest pose under the current root frame (reset / teleport). */
export function buildResetKernel(ctx: GroupContext): N {
  const { G, guideRest: rest, guideFrames: frames, guidePos: pos, guidePrev: prev } = ctx;
  return (
    Fn(() => {
      const idx = instanceIndex;
      const g = idx.div(uint(G));
      const fb = g.mul(6);
      const f = orthoFrame(frames.element(fb.add(1)).xyz, frames.element(fb.add(2)).xyz);
      const target = frameToWorld(frames.element(fb).xyz, f, rest.element(idx).xyz);
      pos.element(idx).assign(vec4(target, 1));
      prev.element(idx).assign(vec4(target, 1));
    }) as N
  )()
    .compute(ctx.Ng * G, [64])
    .setName('hair.reset');
}

/**
 * Strand solver: one thread per guide, all substeps inside the kernel.
 * Order per substep: pin roots → Verlet (inertia control, damping, gravity, wind drag) →
 * global shape → local shape (TressFX 4) → DFTL sweep with collisions and friction inside.
 * After the substeps, any broken strand resets to its rest pose.
 */
export function buildSolveKernel(ctx: GroupContext): N {
  const {
    G,
    u,
    guidePos: pos,
    guidePrev: prev,
    guideRest: rest,
    guideFrames: frames,
    guideRootTri,
    profile,
    colliders,
  } = ctx;
  const U = u as unknown as Record<string, N>;

  const windAt = (x: N, seed: N): N => {
    const t = U.time;
    const gust = float(1).add(
      U.windGust.mul(
        sin(t.mul(0.9).add(seed.mul(6.283)))
          .mul(0.6)
          .add(sin(t.mul(2.7).add(seed.mul(3.1))).mul(0.4)),
      ),
    );
    const strength = length(U.wind);
    const noise = mx_noise_vec3(x.mul(U.windFrequency).add(vec3(t.mul(0.7), t.mul(0.25), t.mul(-0.45))));
    return U.wind.mul(gust).add(noise.mul(strength.mul(U.windTurbulence)));
  };

  return (
    Fn(() => {
      const g = instanceIndex;
      const base = g.mul(uint(G)).toVar();
      const fb = g.mul(6);
      const cP = frames.element(fb).xyz.toVar();
      const cT = frames.element(fb.add(1)).xyz.toVar();
      const cN = frames.element(fb.add(2)).xyz.toVar();
      const pP = frames.element(fb.add(3)).xyz.toVar();
      const pT = frames.element(fb.add(4)).xyz.toVar();
      const pN = frames.element(fb.add(5)).xyz.toVar();
      const mask = guideRootTri.element(g).w.toVar();
      const seed = hash(g).toVar();
      const S = U.substeps;
      const Sf = float(S);
      const dt = U.dtSub;
      const dt2 = dt.mul(dt);
      const stepFrac = float(1).div(Sf);
      const pin = uint(PIN);

      Loop({ start: uint(0), end: S, type: 'uint', condition: '<' }, ({ i: s }: { i: N }) => {
        const a1 = float(s.add(1)).div(Sf).toVar();
        const a0 = float(s).div(Sf);
        const O1 = mix(pP, cP, a1).toVar();
        const F1 = orthoFrame(mix(pT, cT, a1), mix(pN, cN, a1));
        const O0 = mix(pP, cP, a0).toVar();
        const F0 = orthoFrame(mix(pT, cT, a0), mix(pN, cN, a0));

        // Pinned particles follow the (substep-interpolated) root frame exactly.
        Loop({ start: uint(0), end: pin, type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
          const tgt = frameToWorld(O1, F1, rest.element(base.add(k)).xyz);
          pos.element(base.add(k)).assign(vec4(tgt, 1));
          prev.element(base.add(k)).assign(vec4(tgt, 1));
        });

        // Verlet integration.
        const ratio = select(s.equal(uint(0)), U.dtRatio, float(1));
        Loop({ start: pin, end: uint(G), type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
          const idx = base.add(k);
          const x = pos.element(idx).xyz.toVar();
          const xp = prev.element(idx).xyz.toVar();
          // Inertia control: carry a fraction of the root's rigid motion (rotation about the root).
          const xF = frameToWorld(O1, F1, frameToLocal(O0, F0, x));
          const xpF = frameToWorld(O1, F1, frameToLocal(O0, F0, xp));
          x.assign(mix(x, xF, U.followRoot));
          xp.assign(mix(xp, xpF, U.followRoot));
          const v = x.sub(xp).mul(ratio).mul(U.dampingFactor).toVar();
          const vmax = U.maxVelocity.mul(dt);
          const vl = length(v);
          If(vl.greaterThan(vmax), () => {
            v.mulAssign(vmax.div(max(vl, 1e-9)));
          });
          // Air drag towards the wind velocity, perpendicular to the strand.
          const parent = pos.element(idx.sub(1)).xyz;
          const tdir = safeNormalize(x.sub(parent), F1.n);
          // Wind noise is the heaviest per-particle math: skip it when there is no wind (uniform branch).
          const windVel = vec3(0).toVar();
          If(dot(U.wind, U.wind).greaterThan(0), () => {
            windVel.assign(windAt(x, seed));
          });
          const rel = windVel.sub(v.div(dt));
          const relPerp = rel.sub(tdir.mul(dot(rel, tdir)));
          const exposure = profile.element(k).z.mul(0.7).add(0.3);
          const acc = U.gravity.add(relPerp.mul(U.drag).mul(exposure));
          prev.element(idx).assign(vec4(x, 1));
          pos.element(idx).assign(vec4(x.add(v).add(acc.mul(dt2)), 1));
        });

        // Global shape: pull towards the groomed pose carried by the root frame.
        Loop({ start: pin, end: uint(G), type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
          const idx = base.add(k);
          const target = frameToWorld(O1, F1, rest.element(idx).xyz);
          const kRaw = clamp(U.globalStiffness.mul(profile.element(k).x), 0, 0.999);
          // 1 − (1 − k)^(dt / DT_REF): the same stiffness per second at any substep length.
          const kk = float(1).sub(pow(float(1).sub(kRaw), U.stiffnessExponent));
          pos.element(idx).assign(vec4(mix(pos.element(idx).xyz, target, kk), 1));
        });

        // Local shape (TressFX 4): keep each segment's rest direction relative to its parent segment.
        Loop({ start: uint(1), end: uint(G - 1), type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
          const idx = base.add(k);
          const xm = pos.element(idx.sub(1)).xyz;
          const x = pos.element(idx).xyz.toVar();
          const xn = pos.element(idx.add(1)).xyz.toVar();
          const bm = frameRotate(F1, rest.element(idx.sub(1)).xyz);
          const b = frameRotate(F1, rest.element(idx).xyz);
          const bn = frameRotate(F1, rest.element(idx.add(1)).xyz);
          const lastVec = safeNormalize(x.sub(xm), F1.n);
          const lastBind = safeNormalize(b.sub(bm), F1.n);
          const targetN = x.add(rotateFromTo(lastBind, lastVec, bn.sub(b)));
          const kRaw = clamp(U.localStiffness.mul(profile.element(k).y), 0, 0.95);
          const kk = float(1)
            .sub(pow(float(1).sub(kRaw), U.stiffnessExponent))
            .mul(0.5);
          const del = targetN.sub(xn).mul(kk).toVar();
          If(k.greaterThanEqual(pin), () => {
            x.subAssign(del);
            pos.element(idx).assign(vec4(x, 1));
          });
          xn.addAssign(del);
          pos.element(idx.add(1)).assign(vec4(xn, 1));
        });

        // DFTL sweep root→tip with collisions inside (place at L, push out, re-project to L).
        Loop({ start: pin, end: uint(G), type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
          const idx = base.add(k);
          const parent = pos.element(idx.sub(1)).xyz.toVar();
          const xOld = pos.element(idx).xyz.toVar();
          const restK = rest.element(idx);
          const L = restK.w;
          const xNew = parent.add(safeNormalize(xOld.sub(parent), F1.n).mul(L)).toVar();
          // Root half-space: keep near-root particles above the skin plane (fur).
          If(profile.element(k).z.lessThanEqual(U.rootPlaneRange).and(U.rootPlane.greaterThan(0)), () => {
            const h = restK.z.mul(U.rootPlane);
            const above = dot(xNew.sub(O1), F1.n);
            If(above.lessThan(h), () => {
              xNew.addAssign(F1.n.mul(h.sub(above)));
            });
          });
          // Colliders that contain the root are only ignored near the root.
          const maskK = select(profile.element(k).z.lessThan(U.rootColliderRange), mask, uint(0xffffffff));
          // Guides get many pushes per frame: at most 1.5 cm each, so hair squeezed where skin meets skin (an
          // arm against the belly) eases out over a few substeps instead of being flung between the surfaces.
          const col = collide(
            colliders,
            u,
            xNew,
            maskK,
            a1,
            stepFrac,
            0.015,
            profile.element(k).z.greaterThanEqual(U.sdfRootRange),
          );
          xNew.assign(parent.add(safeNormalize(col.x.sub(parent), F1.n).mul(L)));
          pos.element(idx).assign(vec4(xNew, 1));
          // DFTL velocity correction: the parent feels the opposite of the child's correction.
          const corr = xNew.sub(xOld);
          If(k.greaterThan(pin), () => {
            prev.element(idx.sub(1)).addAssign(vec4(corr.mul(U.dftlDamping), 0));
          });
          // Friction relative to the collider's motion.
          If(dot(col.normal, col.normal).greaterThan(0.5), () => {
            const xp = prev.element(idx).xyz;
            const vrel = xNew.sub(xp).sub(col.disp);
            const vn = dot(vrel, col.normal);
            const vt = vrel.sub(col.normal.mul(vn));
            const vNew = vt.mul(float(1).sub(U.collisionFriction)).add(col.normal.mul(max(vn, 0)));
            prev.element(idx).assign(vec4(xNew.sub(vNew).sub(col.disp), 1));
          });
        });
      });

      // Safety net: any non-finite or over-stretched strand snaps back to its rest pose. Written as
      // !(seg < limit) so NaN counts as bad too.
      const bad = uint(0).toVar();
      Loop({ start: uint(1), end: uint(G), type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
        const idx = base.add(k);
        const seg = length(pos.element(idx).xyz.sub(pos.element(idx.sub(1)).xyz));
        If(seg.lessThan(rest.element(idx).w.mul(1.5).add(1e-3)).not(), () => {
          bad.assign(uint(1));
        });
      });
      If(bad.equal(uint(1)), () => {
        const F = orthoFrame(cT, cN);
        Loop({ start: uint(0), end: uint(G), type: 'uint', condition: '<' }, ({ i: k }: { i: N }) => {
          const tgt = frameToWorld(cP, F, rest.element(base.add(k)).xyz);
          pos.element(base.add(k)).assign(vec4(tgt, 1));
          prev.element(base.add(k)).assign(vec4(tgt, 1));
        });
      });
    }) as N
  )()
    .compute(ctx.Ng, [64])
    .setName('hair.solve');
}
