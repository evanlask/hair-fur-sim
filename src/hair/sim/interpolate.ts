import { collide } from './collide';
import type { GroupContext } from './context';
import { tsl } from './tsl';
import {
  catmullRom,
  frameRotate,
  frameToLocal,
  orthoFrame,
  rootNormal,
  safeNormalize,
  type N,
} from './tslUtil';

const {
  Fn,
  If,
  Loop,
  bitcast,
  clamp,
  cos,
  cross,
  dot,
  float,
  floor,
  instanceIndex,
  max,
  min,
  mix,
  mx_noise_vec3,
  pow,
  select,
  sin,
  smoothstep,
  uint,
  vec3,
  vec4,
} = tsl;

const TWO_PI = Math.PI * 2;

/**
 * Render strands from guides — one thread per strand, walking root→tip so it can carry a
 * rotation-minimising frame (stable curl), renormalise segment lengths and collide.
 */
export function buildInterpolateKernel(ctx: GroupContext): N {
  const { G, R, u, guidePos, guideRootTri, guideFrames, strandData, deformed, renderPos, colliders } = ctx;
  const U = u as unknown as Record<string, N>;
  const rootSpace = ctx.interpSpace === 'root';

  return (
    Fn(() => {
      const s = instanceIndex;
      const sb = s.mul(uint(4));
      const gi = strandData.element(sb).toVar();
      const wv = bitcast(strandData.element(sb.add(1)), 'vec4').toVar();
      const rt = strandData.element(sb.add(2)).toVar();
      const rb = bitcast(strandData.element(sb.add(3)), 'vec4').toVar();

      // Render root and its smooth frame on the deformed growth mesh.
      const P0 = deformed.element(rt.x.mul(2)).xyz;
      const P1 = deformed.element(rt.y.mul(2)).xyz;
      const P2 = deformed.element(rt.z.mul(2)).xyz;
      const root = P0.mul(rb.x).add(P1.mul(rb.y)).add(P2.mul(rb.z)).toVar();
      const nInterp = deformed
        .element(rt.x.mul(2).add(1))
        .xyz.mul(rb.x)
        .add(deformed.element(rt.y.mul(2).add(1)).xyz.mul(rb.y))
        .add(deformed.element(rt.z.mul(2).add(1)).xyz.mul(rb.z));
      const SF = orthoFrame(P1.sub(P0), rootNormal(P0, P1, P2, nInterp));

      // guideBlend 0 follows only the clump guide (g0); 1 uses the full barycentric blend.
      const w = mix(vec3(1, 0, 0), wv.xyz, U.guideBlend).toVar();
      w.divAssign(max(w.x.add(w.y).add(w.z), 1e-6));
      const Ls = wv.w;
      const guides = [gi.x, gi.y, gi.z].map((g: N) => {
        const fb = g.mul(6);
        const f0 = guideFrames.element(fb).toVar();
        return {
          base: g.mul(uint(G)).toVar(),
          len: f0.w,
          origin: f0.xyz,
          frame: rootSpace
            ? orthoFrame(guideFrames.element(fb.add(1)).xyz, guideFrames.element(fb.add(2)).xyz)
            : null,
        };
      });
      const mask = guideRootTri.element(gi.x).w.toVar();
      // gi.w packs two 16-bit seeds: curl phase and frizz.
      const seed = float(gi.w.bitAnd(uint(0xffff)))
        .div(65535)
        .toVar();
      const seedB = float(gi.w.shiftRight(uint(16)))
        .div(65535)
        .toVar();
      const segLen = Ls.div(R - 1).toVar();

      const prevOut = vec3(root).toVar();
      const T = vec3(SF.n).toVar();
      const ref = vec3(SF.t).toVar();

      Loop({ start: uint(0), end: uint(R), type: 'uint', condition: '<' }, ({ i: j }: { i: N }) => {
        const sj = float(j)
          .div(R - 1)
          .toVar();

        // Sample every bound guide at its own arc length (never past its tip).
        const samples = guides.map((gd) => {
          const uu = clamp(sj.mul(Ls).div(max(gd.len, 1e-5)), 0, 1).mul(G - 1);
          const k0 = min(uint(floor(uu)), uint(G - 2));
          const f = uu.sub(float(k0));
          const km = select(k0.greaterThan(uint(0)), k0.sub(1), uint(0));
          const kp = min(k0.add(2), uint(G - 1));
          const pt = catmullRom(
            guidePos.element(gd.base.add(km)).xyz,
            guidePos.element(gd.base.add(k0)).xyz,
            guidePos.element(gd.base.add(k0.add(1))).xyz,
            guidePos.element(gd.base.add(kp)).xyz,
            f,
          ).toVar();
          const off = gd.frame ? frameToLocal(gd.origin, gd.frame, pt) : pt.sub(gd.origin);
          return { pt, off };
        });
        // 'root' space takes offsets in each guide's root frame and re-applies them in this strand's frame,
        // so strands keep the guide shape across curved skin; 'world' only translates.
        const off = samples[0].off.mul(w.x).add(samples[1].off.mul(w.y)).add(samples[2].off.mul(w.z));
        const target = (rootSpace ? root.add(frameRotate(SF, off)) : root.add(off)).toVar();
        // Clumping towards the nearest guide's curve, converging at the tips.
        target.assign(mix(target, samples[0].pt, U.clump.mul(pow(sj, U.clumpShape))));

        // Renormalise segment lengths (blended guides would otherwise shorten the strand).
        const outPos = vec3(root).toVar();
        If(j.greaterThan(uint(0)), () => {
          outPos.assign(prevOut.add(safeNormalize(target.sub(prevOut), T).mul(segLen)));
          If((U.collideStrands as N).equal(uint(1)), () => {
            const maskJ = select(sj.lessThan(U.rootColliderRange), mask, uint(0xffffffff));
            const col = collide(
              colliders,
              u,
              outPos,
              maskJ,
              float(1),
              float(0),
              1e3,
              sj.greaterThanEqual(U.sdfRootRange),
            );
            outPos.assign(prevOut.add(safeNormalize(col.x.sub(prevOut), T).mul(segLen)));
          });
          // Rotation-minimising frame via double reflection (Wang et al. 2008).
          const v1 = outPos.sub(prevOut);
          const c1 = max(dot(v1, v1), 1e-12);
          const rL = ref.sub(v1.mul(dot(v1, ref).mul(2).div(c1)));
          const tL = T.sub(v1.mul(dot(v1, T).mul(2).div(c1)));
          const newT = safeNormalize(v1, T);
          const v2 = newT.sub(tL);
          const c2 = dot(v2, v2);
          const rNew = select(
            c2.greaterThan(1e-10),
            rL.sub(v2.mul(dot(v2, rL).mul(2).div(max(c2, 1e-10)))),
            rL,
          );
          ref.assign(safeNormalize(rNew.sub(newT.mul(dot(rNew, newT))), ref));
          T.assign(newT);
        });

        // Curl (helix in the RMF) and frizz (smooth noise), both growing from the root.
        const bv = cross(T, ref);
        const phase = seed.mul(TWO_PI).add(sj.mul(U.curlTurns).mul(TWO_PI));
        const amp = U.curlRadius.mul(smoothstep(0, U.curlRamp, sj));
        const curl = ref
          .mul(cos(phase))
          .add(bv.mul(sin(phase)))
          .mul(amp);
        const frizz = mx_noise_vec3(vec3(sj.mul(U.frizzFrequency), seed.mul(37.0), seedB.mul(53.0))).mul(
          U.frizz.mul(sj.mul(sj)),
        );
        // World-space strand width (root→tip taper × per-strand factor) rides along in .w.
        const width = mix(U.rootWidth, U.tipWidth, pow(sj, U.taper)).mul(rb.w);
        renderPos.element(s.mul(uint(R)).add(j)).assign(vec4(outPos.add(curl).add(frizz), width));
        prevOut.assign(outPos);
      });
    }) as N
  )()
    .compute(ctx.Ns, [64])
    .setName('hair.interpolate');
}
