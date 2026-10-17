import * as THREE from 'three/webgpu';

import type { HairUniforms } from '../params';
import { FRESH_BIT } from '../sim/compact';
import { tsl } from '../sim/tsl';
import { pcgHash, safeNormalize, type N } from '../sim/tslUtil';

const {
  Fn,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  cross,
  float,
  hash,
  instanceIndex,
  max,
  min,
  mix,
  positionGeometry,
  screenSize,
  select,
  smoothstep,
  uint,
  nodeObject,
  positionPrevious,
  screenCoordinate,
  uniform,
  unpackHalf2x16,
  unpackSnorm2x16,
  varyingProperty,
  vec3,
  vec4,
} = tsl;

/**
 * WGSL fragment output `@builtin(sample_mask)`. Writing it lets a single per-pixel invocation keep
 * any subset of the MSAA samples — per-sample stochastic coverage without per-sample shading (4×
 * fewer fragment invocations than reading `sample_index`). Built like three's own frag_depth output.
 */
class SampleMaskNode extends THREE.Node {
  constructor() {
    super('uint');
  }

  generate(builder: N): string {
    const b = builder as {
      getBuiltin(name: string, property: string, type: string, shaderStage: string): string;
    };
    return 'output.' + b.getBuiltin('sample_mask', 'sampleMask', 'u32', 'output');
  }
}

/**
 * 'stochastic': per-MSAA-sample random coverage. 'alphaToCoverage': MSAA alpha to coverage.
 * 'temporal': per-pixel random coverage that changes every frame, resolved by TAA (no MSAA).
 */
export type CoverageMode = 'stochastic' | 'alphaToCoverage' | 'temporal';
/** Strand coverage technique (changing it requires rebuilding the hair materials). */
export const hairRenderSettings: { coverage: CoverageMode } = { coverage: 'stochastic' };
/** Frame counter for temporal coverage noise. */
export const hairFrame = uniform(0, 'uint');

/** Strands drawn per instance (batching avoids per-instance overhead on tiled GPUs). */
export const STRANDS_PER_INSTANCE = 16;

/**
 * Template ribbon geometry for K strands: `points` points × 2 sides each.
 * position = (point index, side, strand-in-batch).
 */
export function createRibbonGeometry(points: number, K = STRANDS_PER_INSTANCE): THREE.BufferGeometry {
  const perStrand = points * 2;
  const pos = new Float32Array(K * perStrand * 3);
  const idx: number[] = [];
  for (let k = 0; k < K; k++) {
    for (let j = 0; j < points; j++) {
      pos.set([j, -1, k], (k * perStrand + j * 2) * 3);
      pos.set([j, 1, k], (k * perStrand + j * 2 + 1) * 3);
    }
    for (let j = 0; j < points - 1; j++) {
      const a = k * perStrand + j * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  // Real positions come from the vertex shader, so the bounds can't be computed from the template.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

interface RibbonInputs {
  R: number;
  /** Strand points: xyz position, w width. */
  renderPos: N;
  widthScale: N;
  minPixelWidth: N;
  /** Number of strands currently drawn; batch slots beyond it collapse. */
  strandCount: N;
  /** Geometry point j maps to strand point min(j·stride, R−1) (shadow and draw LOD); a number or uint node. */
  pointStride?: N;
  /**
   * Per-point output of the shade kernel (uvec4: half2 rg, half2 b·alpha, snorm2 Txy, snorm2 Tz·0).
   * Without it the tangent comes from neighbouring points.
   */
  shaded?: N;
  /**
   * Compacted strands (see StrandCompaction): batch slots index this list of strand indices, and slots past
   * `count` collapse. Replaces the `strandCount` prefix.
   */
  list?: StrandList;
}

/** A list of strands to draw (entry at a slot) and its length, read from storage in the vertex stage. */
export interface StrandList {
  entry: (slot: N) => N;
  count: N;
}

/**
 * Expands strand point j of instance `instanceIndex` into a camera-facing ribbon vertex.
 * Works for perspective and orthographic cameras (light passes). Returns world position,
 * coverage (≤1 when the strand is thinner than the minimum pixel width) and indices.
 */
function ribbonVertex(o: RibbonInputs): {
  pos: N;
  center: N;
  coverage: N;
  strand: N;
  j: N;
  index: N;
  shaded: N;
} {
  const R = o.R;
  const slot = instanceIndex.mul(uint(STRANDS_PER_INSTANCE)).add(uint((positionGeometry as N).z));
  const listCount = o.list ? o.list.count.toVar() : null;
  const strand = o.list
    ? o.list
        .entry(min(slot, max(listCount, uint(1)).sub(1)))
        .bitAnd(uint(~FRESH_BIT >>> 0))
        .toVar()
    : slot;
  const stride = typeof o.pointStride === 'number' ? uint(o.pointStride) : (o.pointStride ?? uint(1));
  const j = min(uint((positionGeometry as N).x).mul(stride), uint(R - 1));
  const sideSign = (positionGeometry as N).y;
  const sRead = o.list ? strand : min(strand, max(o.strandCount, uint(1)).sub(1));
  const base = sRead.mul(uint(R));
  const index = base.add(j);
  const p4 = o.renderPos.element(index).toVar();
  const p = p4.xyz;
  let T: N;
  let shaded: N = null;
  if (o.shaded) {
    shaded = o.shaded.element(index).toVar();
    T = vec3(unpackSnorm2x16(shaded.z), unpackSnorm2x16(shaded.w).x);
  } else {
    const jm = select(j.greaterThan(uint(0)), j.sub(1), uint(0));
    const jn = min(j.add(1), uint(R - 1));
    T = safeNormalize(
      o.renderPos.element(base.add(jn)).xyz.sub(o.renderPos.element(base.add(jm)).xyz),
      vec3(0, 1, 0),
    );
  }
  // projection[3][3] is 1 for orthographic cameras and 0 for perspective ones.
  const isOrtho = (cameraProjectionMatrix as N).element(3).w;
  const camZ = (cameraWorldMatrix as N).element(2).xyz;
  const V = safeNormalize(mix(cameraPosition.sub(p), camZ, isOrtho), camZ);
  // Arbitrary fallback axis for strands pointing straight at the camera.
  const side = safeNormalize(cross(T, V), safeNormalize(cross(T, vec3(0.31, 0.77, 0.55)), vec3(1, 0, 0)));
  const width = p4.w.mul(o.widthScale);
  const viewZ = max((cameraViewMatrix as N).mul(vec4(p, 1)).z.negate(), 1e-4);
  // World-space size of one pixel at this depth.
  const pixelWorld = mix(viewZ, float(1), isOrtho)
    .mul(2)
    .div((cameraProjectionMatrix as N).element(1).y.mul(screenSize.y));
  const minW = pixelWorld.mul(o.minPixelWidth);
  const coverage = clamp(width.div(max(minW, 1e-9)), 0, 1);
  const pos = p.add(side.mul(sideSign.mul(max(width, minW)).mul(0.5)));
  // Unused batch slots and culled strands (negative width) collapse to a degenerate point (zero-area triangles),
  // and so do points the shade kernel skipped (hidden strands: all zero, a lit point has a unit tangent).
  let live: N = (o.list ? slot.lessThan(listCount) : strand.lessThan(o.strandCount)).and(
    p4.w.greaterThanEqual(0),
  );
  if (shaded) live = live.and(shaded.z.bitOr(shaded.w).notEqual(uint(0)));
  return { pos: select(live, pos, vec3(0)), center: p, coverage, strand, j, index, shaded };
}

export interface HairMaterialOptions {
  R: number;
  renderPos: N;
  renderColor: N;
  u: HairUniforms;
  /** Last frame's strand points (temporal coverage): feeds motion vectors for TAA. */
  prevRenderPos?: N;
  /** Draw only these strands (compacted, see StrandCompaction). */
  list?: StrandList;
}

/**
 * Main strand material: unlit ribbons colored by the shade kernel. Sub-pixel coverage (thin strands,
 * LOD fade, tip fade) is resolved according to `hairRenderSettings.coverage`.
 */
export class HairMaterial extends THREE.NodeMaterial {
  constructor(o: HairMaterialOptions) {
    super();
    this.lights = false;
    this.side = THREE.DoubleSide;
    this.forceSinglePass = true;
    this.fog = false;
    const U = o.u as unknown as Record<string, N>;
    const vColor = varyingProperty('vec3', 'vHairColor') as N;
    const vAlpha = varyingProperty('float', 'vHairAlpha') as N;
    const vSeed = varyingProperty('float', 'vHairSeed') as N;
    const mode = hairRenderSettings.coverage;
    const randomCoverage = mode !== 'alphaToCoverage';
    const prevRenderPos = mode === 'temporal' ? o.prevRenderPos : null;

    this.positionNode = (
      Fn(() => {
        const r = ribbonVertex({
          R: o.R,
          renderPos: o.renderPos,
          widthScale: U.widthScale,
          minPixelWidth: U.minPixelWidth,
          strandCount: U.strandCount,
          pointStride: U.drawStride,
          shaded: o.renderColor,
          list: o.list,
        });
        const c = r.shaded;
        const rg = unpackHalf2x16(c.x);
        const ba = unpackHalf2x16(c.y);
        const lodFade = float(1).sub(
          smoothstep(float(U.lodFadeStart), float(U.lodFadeEnd).add(1), float(r.strand)),
        );
        const alpha = ba.y.mul(r.coverage).mul(lodFade);
        vColor.assign(vec3(rg.x, rg.y, ba.x));
        vSeed.assign(hash(r.strand.mul(uint(31)).add(uint(7))));
        if (prevRenderPos) {
          // The ribbon offset is reused for last frame's centre point: motion vectors include strand motion.
          positionPrevious.assign(prevRenderPos.element(r.index).xyz.add(r.pos.sub(r.center)));
        }
        if (randomCoverage) {
          vAlpha.assign(clamp(alpha, 0, 1));
        } else {
          // Alpha-to-coverage, dithered per strand segment (4× MSAA only has 5 coverage levels).
          const dither = hash(r.strand.mul(uint(17)).add(r.j.div(uint(3))))
            .sub(0.5)
            .mul(0.25);
          vAlpha.assign(clamp(alpha.add(dither.mul(alpha.greaterThan(0.002).select(1, 0))), 0, 1));
        }
        return r.pos;
      }) as N
    )();
    this.colorNode = vec4(vColor, 1);

    if (randomCoverage) {
      // Stochastic coverage: each strand keeps a sample (MSAA) or pixel (TAA, new pattern every
      // frame) with probability alpha, hashed per strand so overlapping strands accumulate opacity.
      const px = uint((screenCoordinate as N).x);
      const py = uint((screenCoordinate as N).y);
      const base = px
        .mul(uint(1973))
        .add(py.mul(uint(9277)))
        .add(uint(vSeed.mul(16777215)));
      if (mode === 'temporal') {
        this.maskNode = hash(base.add((hairFrame as N).mul(uint(26699)))).lessThan(vAlpha);
      } else {
        const sampleMask = nodeObject(new SampleMaskNode()) as N;
        this.maskNode = (
          Fn(() => {
            // One bit per sample (assumes 4× MSAA), each from its own byte of a single PCG hash: 8-bit
            // thresholds are plenty for coverage and save three hashes per fragment.
            const h = pcgHash(base);
            const threshold = uint(clamp(vAlpha, 0, 1).mul(256));
            const bits = uint(0).toVar();
            for (let s = 0; s < 4; s++) {
              bits.assign(
                bits.bitOr(
                  select(
                    h
                      .shiftRight(uint(s * 8))
                      .bitAnd(uint(255))
                      .lessThan(threshold),
                    uint(1 << s),
                    uint(0),
                  ),
                ),
              );
            }
            // The output struct starts zeroed and a zero mask drops every sample, so write it on every path.
            sampleMask.assign(bits);
            return bits.notEqual(uint(0));
          }) as N
        )();
      }
    } else {
      this.alphaToCoverage = true;
      this.opacityNode = vAlpha;
    }
  }
}

/**
 * Light-space hair depth material: writes (depth, −depth) with MIN blending into an RG target,
 * giving the front and back of the hair volume per texel (deep-shadow approximation).
 */
export class HairDepthMaterial extends THREE.NodeMaterial {
  readonly widthScale = uniform(2.5);
  readonly strandCount = uniform(0, 'uint');

  /** `list`: draw only these strands (compacted, see StrandCompaction) instead of the first `strandCount`. */
  constructor(R: number, renderPos: N, pointStride: number, list?: StrandList) {
    super();
    this.lights = false;
    this.fog = false;
    this.side = THREE.DoubleSide;
    this.depthTest = false;
    this.depthWrite = false;
    this.toneMapped = false;
    this.transparent = true;
    this.blending = THREE.CustomBlending;
    this.blendEquation = THREE.MinEquation;
    this.blendSrc = THREE.OneFactor;
    this.blendDst = THREE.OneFactor;
    this.blendEquationAlpha = THREE.MinEquation;
    this.blendSrcAlpha = THREE.OneFactor;
    this.blendDstAlpha = THREE.OneFactor;
    const vDepth = varyingProperty('float', 'vHairDepth') as N;
    this.positionNode = (
      Fn(() => {
        // At least 2 texels wide so sparse strands still give a solid, temporally stable front/back depth.
        const r = ribbonVertex({
          R,
          renderPos,
          widthScale: this.widthScale,
          minPixelWidth: float(2),
          strandCount: this.strandCount,
          pointStride,
          list,
        });
        const clip = (cameraProjectionMatrix as N).mul((cameraViewMatrix as N).mul(vec4(r.pos, 1)));
        vDepth.assign(clip.z.div(clip.w));
        return r.pos;
      }) as N
    )();
    this.outputNode = vec4(vDepth, vDepth.negate(), 0, 1);
  }
}
