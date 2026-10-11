import * as THREE from 'three/webgpu';

import { LPS, HAIRLINE } from '../../hair/groom/styles/mulletStyle';
import {
  LPS_BASE_X,
  LPS_BASE_Z,
  LPS_BOTTOM,
  LPS_CRANIUM_RADII,
  LPS_EAR_CAPSULES,
  LPS_FACE_CAPSULES,
  LPS_SCALE,
  loadHead,
} from '../MulletCharacter';

type V3 = [number, number, number];

/** An ellipsoid in model units. */
export interface Ellipsoid {
  c: THREE.Vector3;
  r: THREE.Vector3;
}

/**
 * Landmarks of the head in model units, as it is loaded (+y up, facing +z). Starter styles and fills work in these
 * coordinates.
 */
export interface HeadFrame {
  /** Centre and radii of the cranium. */
  center: THREE.Vector3;
  radii: THREE.Vector3;
  /** Where the hair whorls on the crown. */
  crown: THREE.Vector3;
  /** x of the face's symmetry plane (mirror painting). */
  midlineX: number;
  /** Hairline height (model y) by azimuth |θ| in degrees around the centre (0 = front, 180 = back). */
  hairline: [number, number][];
  /** Tight around the ears: hair grows down to them but never out of them. */
  ears: Ellipsoid[];
  /** Where hair never grows, whatever is painted (eyes, lips). */
  bare: Ellipsoid[];
}

/** Skin shading of the head: its scan textures. */
export interface SkinAssets {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  normalScale: number;
  /** Specular intensity (r, 0..1), scaled by specularIntensity. */
  specMap: THREE.Texture;
  /** Base roughness: 0.1 rougher where the specular map is black, 0.1 smoother where it is white. */
  roughness: number;
  specularIntensity: number;
  envMapIntensity: number;
}

export interface HeadAssets {
  /** The skin the hair grows on: indexed, model units, +y up, facing +z. */
  geometry: THREE.BufferGeometry;
  skin: SkinAssets;
}

/** A capsule collider between two model-space points; radius in model units. */
export interface CapsuleSpec {
  name: string;
  a: V3;
  b: V3;
  r: number;
}

export interface HeadModel {
  id: string;
  label: string;
  load(): Promise<HeadAssets>;
  /** Model units → meters. */
  scale: number;
  /** Added to model positions before scaling, so the bust's flat bottom is at the origin (centred). */
  offset: THREE.Vector3;
  frame: HeadFrame;
  /** Head colliders; the shoulders and chest use a baked SDF of the torso box below. */
  capsules: CapsuleSpec[];
  torso: { min: THREE.Vector3; max: THREE.Vector3; cell: number; band: number };
  camera: { position: THREE.Vector3; target: THREE.Vector3 };
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The head the studio grooms: the Lee Perry-Smith scan, as Wayne wears it (same placement, colliders, landmarks). */
export const STUDIO_HEAD: HeadModel = {
  id: 'lee',
  label: 'Lee (scan)',
  async load() {
    const a = await loadHead();
    return {
      geometry: a.geometry.clone(),
      skin: {
        map: a.map,
        normalMap: a.normalMap,
        normalScale: 1,
        specMap: a.specMap,
        roughness: 0.55,
        specularIntensity: 0.6,
        envMapIntensity: 0.55,
      },
    };
  },
  scale: LPS_SCALE,
  offset: v(-LPS_BASE_X, -LPS_BOTTOM, -LPS_BASE_Z),
  frame: {
    center: LPS.craniumCenter.clone(),
    radii: LPS_CRANIUM_RADII.clone(),
    crown: v(-0.08, 3.62, -0.95),
    midlineX: LPS.midlineX,
    hairline: HAIRLINE,
    ears: LPS.ears.map((e) => ({ c: e.c.clone(), r: e.r.clone() })),
    // Located on the scan from the front (model units): closed eyelids, lips and the nostrils.
    bare: [
      { c: v(-0.709, 1.6, 1.8), r: v(0.36, 0.13, 0.3) },
      { c: v(0.509, 1.6, 1.8), r: v(0.36, 0.13, 0.3) },
      { c: v(-0.088, 0.475, 2.22), r: v(0.38, 0.13, 0.25) },
      { c: v(-0.275, 0.969, 2.2), r: v(0.1, 0.07, 0.12) },
      { c: v(0.099, 0.949, 2.2), r: v(0.1, 0.07, 0.12) },
    ],
  },
  // MulletCharacter's capsules (there on the neck and head bones; here on the rigid bust).
  capsules: [
    { name: 'cranium', a: [-0.073, 2.2, 0.0], b: [-0.073, 2.1, 0.15], r: 1.72 },
    ...LPS_FACE_CAPSULES,
    ...LPS_EAR_CAPSULES,
    { name: 'neck', a: [-0.08, -0.4, -0.45], b: [-0.08, -1.6, -0.6], r: 1.12 },
  ],
  torso: { min: v(-4.8, -5.6, -4.8), max: v(4.8, -0.9, 1.5), cell: 0.12, band: 0.7 },
  camera: { position: v(0.55, 1.13, 0.79), target: v(0, 1.04, 0.04) },
};
