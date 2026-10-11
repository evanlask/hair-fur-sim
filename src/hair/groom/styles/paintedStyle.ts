import * as THREE from 'three/webgpu';

import type { GroomGroupSpec, GroomStyle, GuideShape, SurfacePoint } from '../types';

/** Groom maps painted per field vertex (see `PaintedStyleOptions.fieldIndex`). Flow is 3 floats per vertex. */
export interface PaintedFields {
  /** 0..1: how much hair grows here. */
  density: Float32Array;
  /** Hair length (m). */
  length: Float32Array;
  /** Comb direction, a unit tangent in the fields' own (model) space. */
  flow: Float32Array;
  /** 0 = combed flat along the surface, 1 = standing straight out. */
  lift: Float32Array;
  /** Bend rate while growing (1/m): how quickly the hair curves towards its bend target. */
  curve: Float32Array;
  /** 0..1: the bend target turns from the comb direction (a curl-under) towards straight down (hanging). */
  gravity: Float32Array;
  /** Guide wave amplitude (m). */
  wave: Float32Array;
}

export const FIELD_NAMES = ['density', 'length', 'flow', 'lift', 'curve', 'gravity', 'wave'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export function createFields(count: number): PaintedFields {
  return {
    density: new Float32Array(count),
    length: new Float32Array(count),
    flow: new Float32Array(count * 3),
    lift: new Float32Array(count),
    curve: new Float32Array(count),
    gravity: new Float32Array(count),
    wave: new Float32Array(count),
  };
}

export interface PaintedLayer {
  spec: GroomGroupSpec;
  fields: PaintedFields;
  /** Multiplies the painted lengths. */
  lengthScale: number;
  /** Waves along a guide. */
  waveCount: number;
  /** Aims the layer's guides as they grow (see GuideShape.steer). */
  steer?: GuideShape['steer'];
}

export interface PaintedStyleOptions {
  layers: PaintedLayer[];
  /** Growth mesh the fields are painted on: its triangles index the field vertices through `fieldIndex`. */
  indices: Uint32Array;
  /** Field vertex of each growth-mesh vertex (UV-seam copies share one). */
  fieldIndex: Int32Array;
  /** Rotation from the fields' space to the growth mesh's world space (bind pose), for the flow. */
  fieldToWorld: THREE.Quaternion;
  /** Optional 0..1 per field vertex where nothing may grow (eyes, lips), whatever is painted. */
  bare?: Float32Array | null;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const tmp = { comb: new THREE.Vector3(), rootComb: new THREE.Vector3() };

/**
 * A groom style read from painted per-vertex maps, one group per layer. Layers may overlap (`group` is −1):
 * each grows wherever its own density is painted.
 */
export function createPaintedStyle(o: PaintedStyleOptions): GroomStyle {
  const { indices, fieldIndex, layers } = o;
  const bare = o.bare ?? null;
  const corner = [0, 0, 0];
  const weight = [0, 0, 0];
  /** Field vertices and barycentric weights of a surface point. */
  const at = (sp: SurfacePoint) => {
    for (let k = 0; k < 3; k++) corner[k] = fieldIndex[indices[sp.tri * 3 + k]];
    weight[0] = sp.u;
    weight[1] = sp.v;
    weight[2] = sp.w;
  };
  const lerp = (f: Float32Array) =>
    f[corner[0]] * weight[0] + f[corner[1]] * weight[1] + f[corner[2]] * weight[2];
  const comb = tmp.comb;
  const flowAt = (f: Float32Array, i: number, out: THREE.Vector3) =>
    out.set(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
  /**
   * The painted comb at a surface point (field space; call `at` first): the blended flow. Where opposite flows cancel
   * (a part line) the corner nearest the point decides, so hair parts cleanly to either side.
   */
  const combAt = (f: PaintedFields, out: THREE.Vector3) => {
    out.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const i = corner[k];
      out.x += f.flow[i * 3] * weight[k];
      out.y += f.flow[i * 3 + 1] * weight[k];
      out.z += f.flow[i * 3 + 2] * weight[k];
    }
    if (out.lengthSq() < 0.04) {
      const k = weight[0] >= weight[1] && weight[0] >= weight[2] ? 0 : weight[1] >= weight[2] ? 1 : 2;
      flowAt(f.flow, corner[k], out);
    }
    return out;
  };
  /** Each guide root's comb, per layer (guide roots are the same objects for every strand of a groom). */
  const guideCombs = layers.map(() => new WeakMap<SurfacePoint, THREE.Vector3>());
  const rootComb = tmp.rootComb;
  let filterLayer = 0;
  /** A strand only follows guides combed within 90° of its own root: not the other side of a parting. */
  const sameSide = (guide: SurfacePoint) => {
    const cache = guideCombs[filterLayer];
    let c = cache.get(guide);
    if (!c) {
      at(guide);
      c = combAt(layers[filterLayer].fields, new THREE.Vector3()).clone();
      cache.set(guide, c);
    }
    return c.dot(rootComb) > 0;
  };

  return {
    groups: layers.map((l) => l.spec),
    group: () => -1,
    density(sp, g) {
      at(sp);
      let d = lerp(layers[g].fields.density);
      if (bare) d *= 1 - lerp(bare);
      // The groomer's sampling density grows as d² (triangle weight × acceptance), so √d makes the painted value
      // the fraction of hair.
      return Math.sqrt(Math.min(1, Math.max(0, d)));
    },
    shape(sp, out: GuideShape, g) {
      at(sp);
      const layer = layers[g];
      const f = layer.fields;
      const n = sp.normal;
      // Comb: the painted flow, laid on the root's tangent plane.
      combAt(f, comb).applyQuaternion(o.fieldToWorld);
      comb.addScaledVector(n, -n.dot(comb));
      if (comb.lengthSq() < 1e-6) comb.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
      if (comb.lengthSq() < 1e-6) comb.set(1, 0, 0).addScaledVector(n, -n.x);
      comb.normalize();
      const lift = Math.min(1, Math.max(0, lerp(f.lift)));
      const gravity = Math.min(1, Math.max(0, lerp(f.gravity)));
      out.length = Math.max(1e-4, lerp(f.length) * layer.lengthScale);
      out.direction
        .copy(n)
        .multiplyScalar(lift)
        .addScaledVector(comb, 1 - lift)
        .normalize();
      out.bendTarget
        .copy(comb)
        .multiplyScalar(1 - gravity)
        .addScaledVector(DOWN, gravity);
      if (out.bendTarget.lengthSq() < 1e-6) out.bendTarget.copy(DOWN);
      out.bendTarget.normalize();
      out.bendRate = Math.max(0, lerp(f.curve));
      out.waveAmplitude = Math.max(0, lerp(f.wave));
      out.waveCount = layer.waveCount;
      out.steer = layer.steer ?? null;
    },
    bindFilter(sp, g) {
      at(sp);
      combAt(layers[g].fields, rootComb);
      filterLayer = g;
      return sameSide;
    },
  };
}
