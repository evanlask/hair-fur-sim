import * as THREE from 'three/webgpu';

/**
 * Surface the hair grows from. Positions/normals are in *bind-pose world space* (meters); the
 * runtime deform stage produces the same vertices in current world space, so root frames built
 * from triangles match between groom time and runtime.
 */
export interface GrowthMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  indices: Uint32Array;
  /** 4 bone indices per vertex (skinned meshes) — used for style regions. */
  skinIndex: Uint16Array | Uint32Array | null;
  skinWeight: Float32Array | null;
  vertexCount: number;
  triangleCount: number;
}

export interface SurfacePoint {
  tri: number;
  u: number;
  v: number;
  w: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  uv: THREE.Vector2 | null;
  /** Interpolated bone weights keyed by bone index (skinned meshes only). */
  bones: Map<number, number> | null;
}

/** Shape of one guide at groom time. */
export interface GuideShape {
  length: number;
  /** Initial growth direction (unit, world). */
  direction: THREE.Vector3;
  /** Direction the strand bends towards while growing (unit) — e.g. gravity for long hair. */
  bendTarget: THREE.Vector3;
  /** Bend rate in 1/m (0 = straight). */
  bendRate: number;
  /** Guide-level wave amplitude (m) and number of waves along the strand. */
  waveAmplitude: number;
  waveCount: number;
}

export interface GroomGroupSpec {
  name: string;
  guideCount: number;
  strandCount: number;
  /** Particles per guide, including the root. */
  guideParticles: number;
  /** Points per render strand. */
  strandPoints: number;
  /** Render strands are shortened by a random fraction up to this (0..1). */
  lengthVariation: number;
  /** Render strand width varies randomly by ± this fraction. */
  widthVariation: number;
  /** 'root' blends guide offsets in root frames (fur on thin limbs), 'world' for long hair. */
  interpSpace: 'world' | 'root';
}

export interface GroomStyle {
  groups: GroomGroupSpec[];
  /** Density weight in [0,1] (0 = no hair) of a group (the one `group(p)` picked, or any for -1). */
  density(p: SurfacePoint, group: number): number;
  /** Group index for a root position, or -1 where every group may grow (layered groups; density decides). */
  group(p: SurfacePoint): number;
  shape(p: SurfacePoint, out: GuideShape, group: number): void;
  /** Optional baked per-strand color (linear RGB 0..1). */
  color?(p: SurfacePoint, group: number): [number, number, number] | null;
}

export interface GuideData {
  count: number;
  particles: number;
  /** i0, i1, i2, collider-enable bitmask. */
  rootTri: Uint32Array;
  /** u, v, w, guide length. */
  rootBary: Float32Array;
  /** Rest position in the root face frame (xyz) and rest length of the segment ending here (w). */
  rest: Float32Array;
  /** Bind-pose world positions (initial state). */
  initWorld: Float32Array;
}

export interface StrandData {
  count: number;
  points: number;
  /** g0 (nearest guide, also the clump target), g1, g2, seed. */
  guides: Uint32Array;
  /** w0, w1, w2, strand length (m). */
  weights: Float32Array;
  /** i0, i1, i2, packed RGBA8 color. */
  rootTri: Uint32Array;
  /** u, v, w, width factor. */
  rootBary: Float32Array;
}

export interface GroomGroupData {
  spec: GroomGroupSpec;
  guides: GuideData;
  strands: StrandData;
  maxLength: number;
}

export interface GroomData {
  groups: GroomGroupData[];
  /** Bounding sphere of the bind-pose guides, padded by a quarter of the max length for motion. */
  boundsCenter: THREE.Vector3;
  boundsRadius: number;
}
