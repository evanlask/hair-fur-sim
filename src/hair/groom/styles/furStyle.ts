import * as THREE from 'three/webgpu';

import type { GroomStyle, SurfacePoint } from '../types';

export interface FurRegion {
  /** Fur length in meters. */
  length: number;
  /** 0 = lies flat along the flow, 1 = stands up along the normal. */
  lift: number;
  /** Comb direction (world, bind pose) — projected onto the surface. */
  flow: THREE.Vector3;
  /** Bend towards the flow / gravity while growing (1/m). */
  bend: number;
}

export interface FurStyleParams {
  lengthScale: number;
  lengthVariation: number;
  guideCount: number;
  strandCount: number;
  guideParticles: number;
  strandPoints: number;
  regions: Record<string, FurRegion>;
  /** Region name per bone index. */
  boneRegion: string[];
  /** Linear RGB at a uv, or null (baked strand colors). */
  sampleColor?: ((u: number, v: number) => [number, number, number]) | null;
  /** Sharp texture lookup for the density mask (defaults to `sampleColor`). */
  sampleMask?: ((u: number, v: number) => [number, number, number]) | null;
  /** Texture luminance below which no fur grows (eyes, nose). */
  bareLuminance: number;
  /**
   * Optional position-based region override (e.g. ears, which share the head bone): a region name, or
   * weighted regions blended over the bone-weighted result in order (smooth transitions).
   */
  regionOverride?: (sp: SurfacePoint) => string | { name: string; weight: number }[] | null;
  /** Optional per-point change to the blended comb direction (world, before projection onto the surface). */
  flowField?: (sp: SurfacePoint, flow: THREE.Vector3) => void;
  /**
   * 0..1 (or per point): downward-facing skin grows its fur along the normal, so long fur hangs instead of
   * hugging it.
   */
  hang?: number | ((sp: SurfacePoint) => number);
  /** Weight of gravity in the bend target (default 0.35). */
  gravityBend?: number;
  /** Optional density multiplier by fur length (e.g. denser short fur so it covers as well as long fur). */
  densityForLength?: (length: number) => number;
  /**
   * How render strands follow their guides (default 'root': guide shapes relative to the root frame, for fur
   * on thin limbs). 'world' suits long fur hanging under gravity, since shapes then don't flip where the skin
   * curves.
   */
  interpSpace?: 'root' | 'world';
  /** Optional change to the baked strand colour (e.g. a spot pattern). */
  tint?: (sp: SurfacePoint, rgb: [number, number, number]) => [number, number, number];
  /** Optional density by body part (0..1); null falls back to the texture mask. */
  densityOverride?: (sp: SurfacePoint) => number | null;
}

const tmpN = new THREE.Vector3();
const tmpFlow = new THREE.Vector3();
const tmpComb = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/** Blends region properties by the root's bone weights, then applies the position-based overrides. */
function blendRegions(p: FurStyleParams, sp: SurfacePoint, out: FurRegion): FurRegion {
  const override = p.regionOverride?.(sp);
  if (typeof override === 'string' && p.regions[override]) {
    const r = p.regions[override];
    out.length = r.length;
    out.lift = r.lift;
    out.bend = r.bend;
    out.flow.copy(r.flow);
    return out;
  }
  blendBoneRegions(p, sp, out);
  if (Array.isArray(override)) {
    for (const { name, weight } of override) {
      const r = p.regions[name];
      if (!r || weight <= 0) continue;
      const w = Math.min(1, weight);
      out.length += (r.length - out.length) * w;
      out.lift += (r.lift - out.lift) * w;
      out.bend += (r.bend - out.bend) * w;
      out.flow.lerp(r.flow, w);
    }
  }
  return out;
}

function blendBoneRegions(p: FurStyleParams, sp: SurfacePoint, out: FurRegion): FurRegion {
  out.length = 0;
  out.lift = 0;
  out.bend = 0;
  out.flow.set(0, 0, 0);
  let total = 0;
  if (sp.bones) {
    for (const [bone, w] of sp.bones) {
      const r = p.regions[p.boneRegion[bone] ?? 'body'] ?? p.regions.body;
      out.length += r.length * w;
      out.lift += r.lift * w;
      out.bend += r.bend * w;
      out.flow.addScaledVector(r.flow, w);
      total += w;
    }
  }
  if (total <= 0) {
    const r = p.regions.body;
    out.length = r.length;
    out.lift = r.lift;
    out.bend = r.bend;
    out.flow.copy(r.flow);
    total = 1;
  }
  out.length /= total;
  out.lift /= total;
  out.bend /= total;
  return out;
}

/** Animal fur: per-bone regions (length/lift/comb), texture-driven color and bare areas. */
export function createFurStyle(p: FurStyleParams): GroomStyle {
  const region: FurRegion = { length: 0, lift: 0, flow: new THREE.Vector3(), bend: 0 };
  const luminance = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return {
    groups: [
      {
        name: 'fur',
        guideCount: p.guideCount,
        strandCount: p.strandCount,
        guideParticles: p.guideParticles,
        strandPoints: p.strandPoints,
        lengthVariation: p.lengthVariation,
        widthVariation: 0.35,
        interpSpace: p.interpSpace ?? 'root',
      },
    ],
    density(sp) {
      const byLength = () =>
        p.densityForLength ? p.densityForLength(blendRegions(p, sp, region).length * p.lengthScale) : 1;
      const override = p.densityOverride?.(sp);
      if (override !== undefined && override !== null) return override > 0 ? override * byLength() : 0;
      const sampleMask = p.sampleMask ?? p.sampleColor;
      if (sampleMask && sp.uv) {
        const c = sampleMask(sp.uv.x, sp.uv.y);
        const l = luminance(c);
        if (l < p.bareLuminance) return 0;
        // Ramps from 25% at the threshold to full density at 1.75× it, so fur thins out towards bare areas.
        return Math.min(1, (l - p.bareLuminance) / Math.max(1e-3, p.bareLuminance) + 0.25) * byLength();
      }
      return byLength();
    },
    group: () => 0,
    shape(sp, out) {
      blendRegions(p, sp, region);
      const n = tmpN.copy(sp.normal);
      tmpFlow.copy(region.flow);
      p.flowField?.(sp, tmpFlow);
      if (tmpFlow.lengthSq() < 1e-6) tmpFlow.copy(DOWN);
      tmpFlow.normalize();
      tmpComb.copy(tmpFlow).addScaledVector(n, -n.dot(tmpFlow));
      if (tmpComb.lengthSq() < 1e-4) tmpComb.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
      if (tmpComb.lengthSq() < 1e-4) tmpComb.set(1, 0, 0).addScaledVector(n, -n.x);
      tmpComb.normalize();
      out.length = Math.max(0.002, region.length * p.lengthScale);
      // Skin facing down (under the chin, belly, arms) grows its fur downwards along the normal.
      const hang = typeof p.hang === 'function' ? p.hang(sp) : (p.hang ?? 0);
      const facingDown = THREE.MathUtils.smoothstep(-n.y, 0.25, 0.9) * hang;
      const lift = region.lift + (1 - region.lift) * facingDown;
      out.direction
        .copy(n)
        .multiplyScalar(lift)
        .addScaledVector(tmpComb, 1 - lift)
        .normalize();
      out.bendTarget
        .copy(tmpComb)
        .addScaledVector(DOWN, p.gravityBend ?? 0.35)
        .normalize();
      out.bendRate = region.bend;
      out.waveAmplitude = 0;
      out.waveCount = 0;
    },
    color(sp) {
      if (!p.sampleColor || !sp.uv) return null;
      const c = p.sampleColor(sp.uv.x, sp.uv.y);
      return p.tint ? p.tint(sp, c) : c;
    },
  };
}
