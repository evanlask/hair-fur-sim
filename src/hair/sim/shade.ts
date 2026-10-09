import { hairBSDF, hairSurface } from '../render/hairBSDF';
import type { HairLighting } from '../render/HairLighting';
import type { HairShadowMap } from '../render/HairShadowPass';
import type { GroupContext } from './context';
import { tsl } from './tsl';
import { safeNormalize, type N } from './tslUtil';

const {
  Fn,
  If,
  clamp,
  dot,
  float,
  hash,
  instanceIndex,
  min,
  mix,
  packHalf2x16,
  packSnorm2x16,
  pow,
  reflect,
  select,
  smoothstep,
  uint,
  uvec4,
  vec2,
  vec3,
} = tsl;

/**
 * Lights every render-strand point once (compute): Marschner BSDF for key / rim / fill, key-light
 * deep-shadow transmittance + opaque shadow, environment ambient with root AO. Writes packed half-float
 * HDR color, alpha and the strand tangent (see GroupContext.renderColor) for the ribbon vertex shader.
 */
export function buildShadeKernel(ctx: GroupContext, lighting: HairLighting, shadow: HairShadowMap): N {
  const { R, u, renderPos, renderColor, strandData, strandHidden, shadowHistory } = ctx;
  const U = u as unknown as Record<string, N>;

  return (
    Fn(() => {
      const idx = instanceIndex;
      const s = idx.div(uint(R));
      const j = idx.mod(uint(R));
      const base = s.mul(uint(R));
      const p4 = renderPos.element(idx).toVar();
      // Last frame's output: all zero if this point wasn't drawn then.
      const prev = renderColor.element(idx).toVar();
      // Culled strands (negative width) and hidden ones (far side of the body, see interpolate) aren't drawn:
      // skip the lighting. Writing zeros also marks them as not drawn for next frame's shadow history.
      // Points between the drawn ones (draw LOD) aren't drawn either.
      const stride = U.drawStride as N;
      const notDrawn = j
        .mod(stride)
        .notEqual(uint(0))
        .and(j.notEqual(uint(R - 1)));
      If(
        p4.w
          .lessThan(0)
          .or(strandHidden.element(s).equal(uint(1)))
          .or(notDrawn),
        () => {
          renderColor.element(idx).assign(uvec4(0));
        },
      ).Else(() => {
        const p = p4.xyz;
        const jm = select(j.greaterThan(uint(0)), j.sub(1), uint(0));
        const jn = min(j.add(1), uint(R - 1));
        const T = safeNormalize(
          renderPos.element(base.add(jn)).xyz.sub(renderPos.element(base.add(jm)).xyz),
          vec3(0, 1, 0),
        ).toVar();
        const V = safeNormalize((lighting.cameraPos as N).sub(p), vec3(0, 0, 1)).toVar();
        const t = float(j)
          .div(R - 1)
          .toVar();

        // Base color: baked per-strand sRGB color (e.g. fur texture) × root→tip gradient × jitter.
        const packed = strandData.element(s.mul(uint(4)).add(uint(2))).w;
        const tex = pow(
          vec3(
            float(packed.bitAnd(uint(255))),
            float(packed.shiftRight(uint(8)).bitAnd(uint(255))),
            float(packed.shiftRight(uint(16)).bitAnd(uint(255))),
          ).div(255),
          vec3(2.2),
        );
        const tint = mix(vec3(1), tex, U.textureInfluence);
        const grad = mix(U.rootColor, U.tipColor, smoothstep(U.gradientStart, U.gradientEnd, t));
        const h1 = hash(s.mul(uint(7)).add(uint(3)));
        const h2 = hash(s.mul(uint(13)).add(uint(11)));
        const value = float(1).add(h1.sub(0.5).mul(2).mul(U.valueJitter));
        const hue = vec3(1).add(vec3(1, 0, -1).mul(h2.sub(0.5).mul(2).mul(U.hueJitter)));
        const baseColor = clamp(grad.mul(tint).mul(value).mul(hue), vec3(0), vec3(1)).toVar();

        // Shadowing from the front/back hair depth map + opaque casters (key light).
        // Temporal smoothing removes residual frame-to-frame flicker of the sparse hair shadow map. A point that
        // wasn't drawn last frame has a stale history, so it starts from the new value.
        const tNew = shadow.transmittancePair(p, U.selfShadowDensity);
        const wasDrawn = prev.z.bitOr(prev.w).notEqual(uint(0));
        const blend = select((U.firstFrame as N).equal(uint(1)).or(wasDrawn.not()), float(1), float(0.3));
        const tPair = mix(shadowHistory.element(idx), tNew, blend).toVar();
        shadowHistory.element(idx).assign(tPair);
        const opaque = shadow.opaqueVisibility(p).toVar();
        const keyDir = lighting.key.dir as N;
        // A light's self-shadow blends the key-side and far-side transmittance by its direction.
        const lightShadow = (dir: N): N => mix(tPair.y, tPair.x, dot(dir, keyDir).mul(0.5).add(0.5));
        const keyShadow = tPair.x.mul(opaque).toVar();
        const ao = mix(U.aoRoot, float(1), smoothstep(0, U.aoRange, t)).toVar();
        // Ambient occlusion from being inside the volume (geometric mean of both directions).
        const volume = tPair.x.mul(tPair.y).sqrt().mul(0.75).add(0.25).mul(ao).toVar();
        const S = hairSurface(V, T, baseColor, U.roughness);

        const key = hairBSDF(lighting.key.dir, S, u, keyShadow);
        const col = key.spec.add(key.diff).mul(lighting.key.color).mul(keyShadow).toVar();
        const rimShadow = lightShadow(lighting.rim.dir).mul(ao).toVar();
        const rim = hairBSDF(lighting.rim.dir, S, u, rimShadow);
        col.addAssign(rim.spec.add(rim.diff).mul(lighting.rim.color).mul(rimShadow));
        const fillShadow = lightShadow(lighting.fill.dir).mul(ao).toVar();
        const fill = hairBSDF(lighting.fill.dir, S, u, fillShadow);
        col.addAssign(fill.spec.add(fill.diff).mul(lighting.fill.color).mul(fillShadow));

        // Environment ambient (SH) around a view-facing pseudo normal and its reflection.
        const fakeN = S.fakeN;
        const envD = lighting.envDiffuse(fakeN);
        const envS = lighting.envDiffuse(reflect(V.negate(), fakeN));
        col.addAssign(envD.mul(baseColor).mul(volume).mul(U.ambient).mul(U.scatter.mul(0.5).add(0.5)));
        // Environment reflection (R lobe): the integrated lobe is ≈ fibre Fresnel (~0.05) × specular × 2, white.
        col.addAssign(envS.mul(U.specular).mul(0.1).mul(volume).mul(U.ambient));

        const alphaBase = float(1)
          .sub(smoothstep(float(1).sub(U.tipFade), 1, t))
          .mul(U.opacity);
        // The tangent rides along so ribbon vertices don't re-read neighbouring points to rebuild it.
        renderColor
          .element(idx)
          .assign(
            uvec4(
              packHalf2x16(vec2(col.x, col.y)),
              packHalf2x16(vec2(col.z, alphaBase)),
              packSnorm2x16(T.xy),
              packSnorm2x16(vec2(T.z, 0)),
            ),
          );
      });
    }) as N
  )()
    .compute(ctx.Ns * R, [64])
    .setName('hair.shade');
}
