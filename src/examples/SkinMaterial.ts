import {
  attribute,
  cameraWorldMatrix,
  diffuseColor,
  exp,
  modelWorldMatrixInverse,
  normalView,
  positionLocal,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

import { SpatialHash } from '../hair/groom/SpatialHash';
import { weldGroups, weldedNormals } from '../util/weld';

/** An ellipsoid: centre and radii (in the mesh's model units). */
export interface SkinEllipsoid {
  c: THREE.Vector3;
  r: THREE.Vector3;
}

/** Deepest the thickness search looks through the skin (m); thicker passes no light. */
export const MAX_THICKNESS = 0.012;
/**
 * How far light gets into skin before it's absorbed or scattered away (m), red, green, blue. Red goes deepest, so
 * thin skin glows red when lit from behind.
 */
const MEAN_FREE_PATH = vec3(0.003, 0.0009, 0.0006);
/** Light from behind reaches a thin part's far side over a little more than a hemisphere (its sides aren't flat). */
const WRAP = 0.3;

/** 0..1: inside any of the ellipsoids, with a soft edge just inside their surface. */
function ellipsoidWeight(list: SkinEllipsoid[], x: number, y: number, z: number): number {
  let k = 0;
  for (const e of list) {
    const d = Math.hypot((x - e.c.x) / e.r.x, (y - e.c.y) / e.r.y, (z - e.c.z) / e.r.z);
    k = Math.max(k, 1 - THREE.MathUtils.smoothstep(d, 0.85, 1.05));
  }
  return k;
}

/**
 * Per vertex of an indexed mesh (model units, `scale` m each): ear thickness (m) straight in to the skin on the other
 * side, capped at MAX_THICKNESS. Off the ears it's MAX_THICKNESS (a scan's inner surfaces behind the eyes, nostrils
 * and lips aren't really thin skin). UV-seam copies are welded and the result is lightly smoothed.
 */
export function skinThickness(
  geometry: THREE.BufferGeometry,
  scale: number,
  ears: SkinEllipsoid[],
): Float32Array {
  const pos = geometry.getAttribute('position');
  const index = geometry.index!.array;
  const n = pos.count;
  const all = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) all.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
  const { groupOf, count } = weldGroups(all);
  const allNormals = weldedNormals(all, index);
  const p = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  for (let i = 0; i < n; i++) {
    p.set(all.subarray(i * 3, i * 3 + 3), groupOf[i] * 3);
    nrm.set(allNormals.subarray(i * 3, i * 3 + 3), groupOf[i] * 3);
  }
  const max = MAX_THICKNESS / scale;
  const hash = new SpatialHash(max, count);
  for (let i = 0; i < count; i++) hash.insert(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);

  const thick = new Float32Array(count).fill(max);
  for (let i = 0; i < count; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    const ear = ellipsoidWeight(ears, x, y, z);
    if (ear === 0) continue;
    const nx = nrm[i * 3];
    const ny = nrm[i * 3 + 1];
    const nz = nrm[i * 3 + 2];
    let best = max;
    // The other side: vertices behind this one (within 60° of straight in) whose skin faces the other way. Their
    // depth along the normal is the distance between the two sides, wherever the vertex is across.
    hash.forEachNear(x, y, z, 1, (j, d2) => {
      if (d2 > max * max || nrm[j * 3] * nx + nrm[j * 3 + 1] * ny + nrm[j * 3 + 2] * nz > -0.3) return;
      const depth = -((p[j * 3] - x) * nx + (p[j * 3 + 1] - y) * ny + (p[j * 3 + 2] - z) * nz);
      if (depth > 0.5 * Math.sqrt(d2) && depth < best) best = depth;
    });
    thick[i] = max - (max - best) * ear;
  }

  // Two passes of averaging with the neighbours along the mesh's edges.
  const neighbors = Array.from({ length: count }, () => new Set<number>());
  for (let t = 0; t < index.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = groupOf[index[t + k]];
      const b = groupOf[index[t + ((k + 1) % 3)]];
      if (a === b) continue;
      neighbors[a].add(b);
      neighbors[b].add(a);
    }
  let cur = thick;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let sum = cur[i];
      for (const j of neighbors[i]) sum += cur[j];
      next[i] = sum / (1 + neighbors[i].size);
    }
    cur = next;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = cur[groupOf[i]] * scale;
  return out;
}

/** What the skin needs for light through thin parts. */
export interface SkinTransmission {
  /** Name of the per-vertex thickness attribute (m), see skinThickness. */
  attribute: string;
  /** The cranium: light from the far side of the head doesn't get through it. */
  cranium: SkinEllipsoid;
  /** Brightness of the light let through. */
  strength: number;
  /**
   * For a head that moves on a bone: maps the drawn (skinned) mesh position into the space the cranium is given in
   * (its owner updates it every frame). The mesh's own space if unset.
   */
  craniumSpace?: THREE.Matrix4;
}

type Vec3Node = THREE.Node<'vec3'>;

/** A light node's colour before shadowing (three keeps it as baseColorNode while shadows are applied). */
interface LightNodeColors {
  baseColorNode?: THREE.Node | null;
  colorNode: THREE.Node;
}

/**
 * Physical skin plus light through thin skin (ears): what falls on a thin part's far side comes out of this side,
 * dimmed per colour by the thickness (Beer–Lambert, MEAN_FREE_PATH), from every lamp. It skips the shadow map (an
 * ear lit from behind is in its own shadow on the side we see); only the cranium can block it, tested as an
 * ellipsoid. Elsewhere the skin is too thick for any to get through.
 */
class SkinLightingModel extends THREE.PhysicalLightingModel {
  private readonly thin: SkinTransmission;

  constructor(thin: SkinTransmission, ...flags: boolean[]) {
    super(...flags);
    this.thin = thin;
  }

  direct(input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder): void {
    super.direct(input, builder);
    const lightDirection = input.lightDirection as Vec3Node;
    const lightNode = input.lightNode as unknown as LightNodeColors;
    const light = (lightNode.baseColorNode ?? lightNode.colorNode) as Vec3Node;
    const thickness = attribute(this.thin.attribute, 'float').max(0);
    const through = exp(thickness.negate().div(MEAN_FREE_PATH));
    const behind = normalView
      .dot(lightDirection)
      .negate()
      .add(WRAP)
      .div(1 + WRAP)
      .saturate();
    (input.reflectedLight.directDiffuse as Vec3Node).addAssign(
      light
        .mul(through)
        .mul(behind.mul(craniumVisibility(this.thin, lightDirection)).mul(this.thin.strength))
        // Lambert: diffuse colour / π.
        .mul(diffuseColor.rgb.mul(1 / Math.PI)),
    );
  }
}

/**
 * 0..1: how much of a lamp's light reaches the point past the cranium, soft-edged: how close the ray towards the
 * lamp passes to the ellipsoid's centre, in its unit-sphere space.
 */
function craniumVisibility(thin: SkinTransmission, toLight: Vec3Node) {
  const { c, r: radii } = thin.cranium;
  const r = vec3(radii.x, radii.y, radii.z);
  const space = thin.craniumSpace ? uniform(thin.craniumSpace) : null;
  const local = space ? space.mul(vec4(positionLocal, 1)).xyz : positionLocal;
  const p = local.sub(vec3(c.x, c.y, c.z)).div(r);
  const world = cameraWorldMatrix.mul(vec4(toLight, 0)).xyz;
  const model = modelWorldMatrixInverse.mul(vec4(world, 0)).xyz;
  const d = (space ? space.mul(vec4(model, 0)).xyz : model).div(r).normalize();
  const ahead = p.dot(d).negate().max(0);
  const miss = p.dot(p).sub(ahead.mul(ahead)).max(0).sqrt();
  return smoothstep(0.85, 1.05, miss);
}

/** Skin: MeshPhysicalNodeMaterial lit by SkinLightingModel. */
export class SkinMaterial extends THREE.MeshPhysicalNodeMaterial {
  static get type(): string {
    return 'SkinMaterial';
  }

  private readonly thin: SkinTransmission;

  constructor(thin: SkinTransmission, parameters?: THREE.MeshPhysicalNodeMaterialParameters) {
    super(parameters);
    this.thin = thin;
  }

  setupLightingModel(): THREE.PhysicalLightingModel {
    return new SkinLightingModel(
      this.thin,
      this.useClearcoat,
      this.useSheen,
      this.useIridescence,
      this.useAnisotropy,
      this.useTransmission,
      this.useDispersion,
      this.useRetroreflection,
    );
  }
}
