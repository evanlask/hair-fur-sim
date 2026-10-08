import * as THREE from 'three/webgpu';

import { tsl } from '../sim/tsl';
import type { N } from '../sim/tslUtil';

const {
  Fn,
  If,
  Loop,
  abs,
  clamp,
  exp,
  float,
  int,
  ivec2,
  max,
  mix,
  select,
  textureLoad,
  uniform,
  vec2,
  vec4,
} = tsl;

/** Layer used to render opaque shadow casters (bodies) into the hair shadow pass. */
export const OPAQUE_SHADOW_LAYER = 5;
/** Layer used by the per-group hair depth meshes. */
export const HAIR_SHADOW_LAYER = 6;

/**
 * Per-character light-space maps for hair shadowing:
 *  - `hairTarget`: RG float target written with MIN blending → (front depth, −back depth) of the
 *    hair volume (deep-shadow approximation: transmittance = exp(−σ · Δd), Δd clamped to thickness).
 *  - `opaqueTarget`: depth of opaque casters (bodies) so strands behind the head get shadowed.
 * A dedicated orthographic camera per character is fit to its bounds and texel-snapped.
 */
export class HairShadowMap {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  readonly hairTarget: THREE.RenderTarget;
  readonly opaqueTarget: THREE.RenderTarget;
  /** world → light clip (WebGPU NDC, z in [0,1]). */
  readonly viewProj = uniform(new THREE.Matrix4());
  /** far − near in meters (ortho depth is linear). */
  readonly depthRange = uniform(1);
  readonly size = uniform(new THREE.Vector2(1, 1));
  readonly hairTex: N;
  readonly opaqueTex: N;

  resolution: number;

  constructor(resolution: number, float32Blendable: boolean) {
    this.resolution = resolution;
    this.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    // MIN blending into a float32 target needs the float32-blendable feature.
    this.hairTarget = new THREE.RenderTarget(resolution, resolution, {
      type: float32Blendable && resolution > 4096 ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RGFormat,
      depthBuffer: false,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    const depth = new THREE.DepthTexture(resolution, resolution);
    depth.type = THREE.FloatType;
    this.opaqueTarget = new THREE.RenderTarget(resolution, resolution, {
      depthBuffer: true,
      generateMipmaps: false,
    });
    this.opaqueTarget.depthTexture = depth;
    this.hairTex = this.hairTarget.texture;
    this.opaqueTex = depth;
    this.size.value.set(resolution, resolution);
  }

  /** Fits the light camera around a bounding sphere, snapping to texels to avoid shimmering. */
  fit(lightDir: THREE.Vector3, center: THREE.Vector3, radius: number): void {
    const cam = this.camera;
    const r = Math.max(radius, 0.05);
    const dir = lightDir.clone().normalize();
    const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    // Snap the center in light space to whole texels.
    const basisZ = dir;
    const basisX = new THREE.Vector3().crossVectors(up, basisZ).normalize();
    const basisY = new THREE.Vector3().crossVectors(basisZ, basisX);
    const texel = (2 * r) / this.resolution;
    const cx = Math.round(center.dot(basisX) / texel) * texel;
    const cy = Math.round(center.dot(basisY) / texel) * texel;
    const cz = center.dot(basisZ);
    const snapped = basisX.clone().multiplyScalar(cx).addScaledVector(basisY, cy).addScaledVector(basisZ, cz);
    const dist = r * 2 + 1;
    cam.position.copy(snapped).addScaledVector(dir, dist);
    cam.up.copy(up);
    cam.lookAt(snapped);
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = dist - r * 1.5;
    cam.far = dist + r * 1.5;
    cam.coordinateSystem = THREE.WebGPUCoordinateSystem;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.viewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.depthRange.value = cam.far - cam.near;
  }

  /** Light-space uv and depth (both 0–1) of a world position. */
  project(p: N): { uv: N; depth: N } {
    const c = (this.viewProj as N).mul(vec4(p, 1));
    const ndc = c.xyz.div(c.w);
    const uv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)); // texture v points down
    return { uv, depth: ndc.z };
  }

  /**
   * Hair transmittance at world position p from the front/back depth map. Returns vec2(towards the
   * light, towards the opposite direction): light arriving from the key side is attenuated by the hair
   * between p and the volume's front, light from the far side by the hair between p and the back.
   * `density` is σ in 1/m; `bias` in meters.
   */
  transmittancePair(p: N, density: N, bias: N = float(0.002)): N {
    const { uv, depth } = this.project(p);
    const size = this.size as N;
    const texel = uv.mul(size);
    const base = ivec2(texel.floor());
    const sum = vec2(0).toVar();
    const wsum = float(0).toVar();
    const range = this.depthRange as N;
    // 3×3 tent filter: averages exp() per tap (never the depths) for a smooth, stable result.
    Loop(9, ({ i }: { i: N }) => {
      const o = ivec2(i.mod(int(3)).sub(1), i.div(int(3)).sub(1));
      const wgt = float(2)
        .sub(abs(float(o.x)))
        .mul(float(2).sub(abs(float(o.y))));
      const c = clamp(base.add(o), ivec2(0), ivec2(size.sub(1)));
      const fb = textureLoad(this.hairTex, c).xy;
      const front = fb.x;
      const back = fb.y.negate();
      const thickness = max(back.sub(front), 0);
      const dFront = clamp(depth.sub(front), 0, thickness).mul(range).sub(bias);
      const dBack = clamp(back.sub(depth), 0, thickness).mul(range).sub(bias);
      sum.addAssign(
        vec2(exp(max(dFront, 0).mul(density).negate()), exp(max(dBack, 0).mul(density).negate())).mul(wgt),
      );
      wsum.addAssign(wgt);
    });
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
    return mix(vec2(1), sum.div(wsum), inside.select(1, 0));
  }

  /** Transmittance towards the key light only. */
  transmittance(p: N, density: N, bias: N = float(0.002)): N {
    return this.transmittancePair(p, density, bias).x;
  }

  /**
   * Key-light transmittance for surfaces (skin, floor): a 3-texel box filter positioned with
   * sub-texel precision (4×4 taps, weights 1−f, 1, 1, f), so hair shadows on skin stay smooth
   * instead of stepping from texel to texel.
   */
  transmittanceSmooth(p: N, density: N, bias: N = float(0.003)): N {
    const { uv, depth } = this.project(p);
    const size = this.size as N;
    const texel = uv.mul(size).sub(0.5);
    const base = ivec2(texel.floor());
    const f = texel.fract();
    const range = this.depthRange as N;
    const result = float(1).toVar();
    // Most floor / skin pixels are outside the hair's shadow footprint: skip the taps there.
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
    If(inside, () => {
      const sum = float(0).toVar();
      Loop(16, ({ i }: { i: N }) => {
        const ox = i.mod(int(4)).sub(1);
        const oy = i.div(int(4)).sub(1);
        const weight1 = (o: N, fr: N) =>
          select(o.equal(int(-1)), float(1).sub(fr), select(o.equal(int(2)), fr, float(1)));
        const wgt = weight1(ox, f.x).mul(weight1(oy, f.y));
        const c = clamp(base.add(ivec2(ox, oy)), ivec2(0), ivec2(size.sub(1)));
        const fb = textureLoad(this.hairTex, c).xy;
        const front = fb.x;
        const thickness = max(fb.y.negate().sub(front), 0);
        const dFront = clamp(depth.sub(front), 0, thickness).mul(range).sub(bias);
        sum.addAssign(exp(max(dFront, 0).mul(density).negate()).mul(wgt));
      });
      result.assign(sum.div(9));
    });
    return result;
  }

  /** Opaque-caster visibility (bilinear 2×2 PCF on the opaque depth map). */
  opaqueVisibility(p: N, bias: N = float(0.004)): N {
    const { uv, depth } = this.project(p);
    const size = this.size as N;
    const texel = uv.mul(size).sub(0.5);
    const base = ivec2(texel.floor());
    const f = texel.fract();
    const v = float(0).toVar();
    const range = this.depthRange as N;
    const b = bias.div(range);
    Loop(4, ({ i }: { i: N }) => {
      const ox = i.mod(int(2));
      const oy = i.div(int(2));
      const c = clamp(base.add(ivec2(ox, oy)), ivec2(0), ivec2(size.sub(1)));
      const d = textureLoad(this.opaqueTex, c).x;
      const lit = depth.sub(b).lessThanEqual(d).select(1, 0);
      const wx = mix(float(1).sub(f.x), f.x, float(ox));
      const wy = mix(float(1).sub(f.y), f.y, float(oy));
      v.addAssign(float(lit).mul(wx).mul(wy));
    });
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
    return mix(float(1), v, inside.select(1, 0));
  }

  dispose(): void {
    this.hairTarget.dispose();
    this.opaqueTarget.dispose();
  }
}

let receiverVersion = 0;

/**
 * Sets a material's received-shadow callback and forces a pipeline rebuild. three.js keys pipelines on
 * String(value) for function-valued properties and every TSL Fn stringifies the same, so swapping the
 * callback alone (e.g. after a regroom created new shadow maps) would keep sampling the old maps.
 */
export function setReceivedShadow(material: THREE.NodeMaterial, fn: N): void {
  material.receivedShadowNode = fn;
  (material as THREE.NodeMaterial & { hairShadowKey?: string }).hairShadowKey =
    `hair-shadow-${++receiverVersion}`;
  material.needsUpdate = true;
}

/** Material helper: multiply a body material's received (key-light) shadow by hair transmittance. */
export function applyHairShadow(material: THREE.NodeMaterial, map: HairShadowMap, density: N): void {
  const { positionWorld } = tsl;
  setReceivedShadow(
    material,
    Fn(([shadow]: [N]) => shadow.mul(map.transmittanceSmooth(positionWorld, density))),
  );
}
