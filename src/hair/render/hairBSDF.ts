import type { HairUniforms } from '../params';
import { tsl } from '../sim/tsl';
import { safeNormalize, type N } from '../sim/tslUtil';

const { abs, clamp, dot, exp, exp2, float, inverseSqrt, log2, luminance, max, mix, pow, sqrt, vec3 } = tsl;

// Fresnel F0 for keratin (η = 1.55).
const HAIR_F0 = Math.pow((1 - 1.55) / (1 + 1.55), 2);

const hairF = (cosTheta: N): N => float(HAIR_F0).add(float(1 - HAIR_F0).mul(pow(float(1).sub(cosTheta), 5)));
const hairG = (b: N, theta: N): N =>
  exp(theta.mul(theta).mul(-0.5).div(b.mul(b))).div(b.mul(Math.sqrt(2 * Math.PI)));

/** Per-point terms shared by every light's BSDF evaluation (view, tangent, base colour). */
export interface HairSurface {
  V: N;
  T: N;
  base: N;
  /** log2 of the base colour: the BSDF's colour powers become exp2(k · logBase). */
  logBase: N;
  logLuma: N;
  sqrtBase: N;
  sinThetaV: N;
  cosV: N;
  Vp: N;
  VpLen2: N;
  /** View-facing pseudo normal (perpendicular to T). */
  fakeN: N;
  r2: N;
}

/** Precomputes the light-independent BSDF terms once per point. V, T: unit view and tangent vectors. */
export function hairSurface(V: N, T: N, base: N, roughness: N): HairSurface {
  const rough = clamp(roughness, 1 / 255, 1);
  const sinThetaV = clamp(dot(T, V), -1, 1).toVar();
  const Vp = V.sub(T.mul(sinThetaV)).toVar();
  // Clamped so a black channel gives exp2(−large) = 0 rather than NaN from −inf · 0.
  const logBase = log2(max(base, vec3(1e-6))).toVar();
  return {
    V,
    T,
    base,
    logBase,
    logLuma: log2(max(luminance(base), 1e-4)).toVar(),
    sqrtBase: sqrt(base).toVar(),
    sinThetaV,
    cosV: sqrt(clamp(float(1).sub(sinThetaV.mul(sinThetaV)), 0, 1)).toVar(),
    Vp,
    VpLen2: dot(Vp, Vp).toVar(),
    fakeN: safeNormalize(Vp, V).toVar(),
    r2: rough.mul(rough).toVar(),
  };
}

/** base^k for a scalar k, via the shared log2(base). */
const basePow = (S: HairSurface, k: N): N => exp2(S.logBase.mul(k));

/**
 * Marschner-style hair BSDF (R / TT / TRT lobes + multiple-scattering diffuse), following the
 * real-time approximation in Karis 2016, "Physically Based Hair Shading in Unreal".
 * L: unit vector towards the light, in the same space as the surface's V and T.
 * `shadow` (transmittance, 1 = lit) tints the multiple-scattering term: deeper inside = more saturated.
 */
export function hairBSDF(L: N, S: HairSurface, u: HairUniforms, shadow: N): { spec: N; diff: N } {
  const U = u as unknown as Record<string, N>;
  const { T, sinThetaV, cosV, Vp, r2 } = S;
  const VoL = dot(S.V, L);
  const sinThetaL = clamp(dot(T, L), -1, 1).toVar();
  // cos((θv − θl) / 2) without trig: sqrt((1 + cosθv·cosθl + sinθv·sinθl) / 2).
  const cosL = sqrt(clamp(float(1).sub(sinThetaL.mul(sinThetaL)), 0, 1));
  const cosThetaD = max(
    sqrt(clamp(cosV.mul(cosL).add(sinThetaV.mul(sinThetaL)).add(1).mul(0.5), 0, 1)),
    0.05,
  ).toVar();
  const Lp = L.sub(T.mul(sinThetaL));
  const cosPhi = dot(Lp, Vp)
    .mul(inverseSqrt(dot(Lp, Lp).mul(S.VpLen2).add(1e-4)))
    .toVar();
  const cosHalfPhi = sqrt(clamp(cosPhi.mul(0.5).add(0.5), 0, 1)).toVar();
  // Karis's fit for the modified refraction index η′.
  const nPrime = float(1.19).div(cosThetaD).add(cosThetaD.mul(0.36));
  const shift = U.shift;
  const sumSin = sinThetaL.add(sinThetaV);

  // R: primary (white) reflection, shifted towards the root by the cuticle tilt.
  const sa = U.cuticleSin;
  const ca = U.cuticleCos;
  const shiftR = sa.mul(2).mul(ca.mul(cosHalfPhi).mul(cosV).add(sa.mul(sinThetaV)));
  const mpR = hairG(max(r2.mul(Math.SQRT2).mul(cosHalfPhi), 1e-3), sumSin.sub(shiftR));
  const npR = cosHalfPhi.mul(0.25);
  const fpR = hairF(sqrt(clamp(VoL.mul(0.5).add(0.5), 0, 1)));
  const lobeR = mpR
    .mul(npR)
    .mul(fpR)
    .mul(U.specular)
    .mul(2)
    .mul(mix(1, U.backlit, clamp(VoL.negate(), 0, 1)));

  // TT: transmission through the fibre (back-lit glow, takes the hair color).
  const mpTT = hairG(r2.mul(0.5), sumSin.sub(shift));
  const a = float(1).div(nPrime);
  const h = cosHalfPhi.mul(float(1).add(a.mul(float(0.6).sub(cosPhi.mul(0.8)))));
  const fTT = hairF(cosThetaD.mul(sqrt(clamp(float(1).sub(h.mul(h)), 0, 1))));
  const fpTT = float(1).sub(fTT).pow(2);
  const tpTT = basePow(
    S,
    sqrt(clamp(float(1).sub(h.mul(a).pow(2)), 0, 1))
      .mul(0.5)
      .div(cosThetaD),
  );
  const npTT = exp(cosPhi.mul(-3.65).sub(3.98));
  const lobeTT = tpTT.mul(mpTT.mul(npTT).mul(fpTT).mul(U.backlit));

  // TRT: secondary (colored) highlight, shifted towards the tip.
  const mpTRT = hairG(r2.mul(2), sumSin.sub(shift.mul(4)));
  const fTRT = hairF(cosThetaD.mul(0.5));
  const fpTRT = float(1).sub(fTRT).pow(2).mul(fTRT);
  const tpTRT = basePow(S, float(0.8).div(cosThetaD));
  const npTRT = exp(cosPhi.mul(17).sub(16.78));
  const lobeTRT = tpTRT.mul(mpTRT.mul(npTRT).mul(fpTRT));

  const spec = max(vec3(lobeR).add(lobeTT).add(lobeTRT), vec3(0));

  // Multiple scattering approximation (soft Kajiya-Kay + wrap), more saturated in shadow.
  const kajiya = float(1).sub(abs(sinThetaL));
  const noL = clamp(dot(S.fakeN, L).add(1).div(4), 0, 1);
  const diffuseScatter = mix(noL, kajiya, 0.33)
    .mul(U.scatter)
    .mul(1 / Math.PI);
  // (base / luma)^(1 − shadow)
  const scatterTint = exp2(S.logBase.sub(S.logLuma).mul(float(1).sub(shadow)));
  const diff = S.sqrtBase.mul(diffuseScatter).mul(scatterTint);
  return { spec, diff };
}
