import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import * as THREE from 'three/webgpu';

import { ColliderSet } from '../hair/colliders';
import { createFurStyle, type FurRegion } from '../hair/groom/styles/furStyle';
import { skinnedGrowth } from '../hair/growth';
import type { HairInstance } from '../hair/HairInstance';
import type { HairSystem } from '../hair/HairSystem';
import type { HairParamsData } from '../hair/params';
import { ColliderDebug } from '../hair/render/ColliderDebug';
import { OPAQUE_SHADOW_LAYER, applyHairShadow } from '../hair/render/HairShadowPass';
import { createTextureSampler } from '../util/texture';
import { weldedNormals } from '../util/weld';
import { FoxPath } from './FoxPath';

/** Model is authored in centimetres; this gives a ~1.1 m long fox. */
export const FOX_SCALE = 0.007;
export type FoxAnimation = 'Survey' | 'Walk' | 'Run';

export interface FoxGroomParams {
  lengthScale: number;
  tailLength: number;
  ruffLength: number;
  lengthVariation: number;
  guideCount: number;
  strandCount: number;
  guideParticles: number;
  strandPoints: number;
}

export const defaultFoxGroom = (): FoxGroomParams => ({
  lengthScale: 1,
  tailLength: 0.075,
  ruffLength: 0.045,
  lengthVariation: 0.5,
  guideCount: 2600,
  strandCount: 240000,
  guideParticles: 8,
  strandPoints: 8,
});

let gltfPromise: Promise<GLTF> | null = null;
export function loadFox(): Promise<GLTF> {
  return (gltfPromise ??= new GLTFLoader().loadAsync('models/fox/Fox.glb'));
}

/** Region name per bone index (joint order of the Khronos Fox skin). */
const BONE_REGION = [
  'body',
  'body',
  'body',
  'body',
  'body',
  'neck',
  'head',
  'upperLeg',
  'lowerLeg',
  'paw',
  'upperLeg',
  'lowerLeg',
  'paw',
  'tail',
  'tail',
  'tailTip',
  'upperLeg',
  'lowerLeg',
  'paw',
  'paw',
  'upperLeg',
  'lowerLeg',
  'paw',
  'paw',
];

function furRegions(g: FoxGroomParams): Record<string, FurRegion> {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
  return {
    body: { length: 0.034, lift: 0.42, flow: v(0, -0.25, -1), bend: 4 },
    neck: { length: g.ruffLength, lift: 0.45, flow: v(0, -0.5, -1), bend: 8 },
    head: { length: 0.016, lift: 0.3, flow: v(0, 0.15, -1), bend: 3 },
    upperLeg: { length: 0.022, lift: 0.25, flow: v(0, -1, -0.2), bend: 4 },
    lowerLeg: { length: 0.012, lift: 0.2, flow: v(0, -1, 0), bend: 2 },
    paw: { length: 0.007, lift: 0.2, flow: v(0, -0.6, 0.8), bend: 0 },
    tail: { length: g.tailLength, lift: 0.55, flow: v(0, -0.6, -1), bend: 10 },
    tailTip: { length: g.tailLength * 0.9, lift: 0.5, flow: v(0, -0.5, -1), bend: 8 },
    ear: { length: 0.016, lift: 0.7, flow: v(0, 1, -0.25), bend: 0 },
  };
}

/** Collision capsules in model space (cm, rest pose) and the bone each follows. */
const CAPSULES: {
  name: string;
  bone: string;
  a: [number, number, number];
  b: [number, number, number];
  r: number;
}[] = [
  { name: 'hips', bone: 'b_Hip_01', a: [0, 48.5, -36], b: [0, 50, -10], r: 10.5 },
  { name: 'chest', bone: 'b_Spine02_03', a: [0, 50, -10], b: [0, 49, 22], r: 11 },
  { name: 'neck', bone: 'b_Neck_04', a: [0, 53.2, 25], b: [0, 60, 36], r: 9 },
  { name: 'head', bone: 'b_Head_05', a: [0, 58, 44], b: [0, 58, 46], r: 8.5 },
  { name: 'snout', bone: 'b_Head_05', a: [0, 56.5, 50], b: [0, 55.5, 62], r: 4 },
  { name: 'rArm', bone: 'b_RightUpperArm_06', a: [-6.97, 47, 18], b: [-6.97, 26, 17.2], r: 4.5 },
  { name: 'rFore', bone: 'b_RightForeArm_07', a: [-6.97, 26, 17.2], b: [-6.97, 6.7, 17.8], r: 2.9 },
  { name: 'lArm', bone: 'b_LeftUpperArm_09', a: [6.97, 47, 18], b: [6.97, 26, 17.2], r: 4.5 },
  { name: 'lFore', bone: 'b_LeftForeArm_010', a: [6.97, 26, 17.2], b: [6.97, 6.7, 17.8], r: 2.9 },
  { name: 'lThigh', bone: 'b_LeftLeg01_015', a: [6.97, 47, -30], b: [6.97, 30.5, -27.4], r: 6 },
  { name: 'lShin', bone: 'b_LeftLeg02_016', a: [6.97, 30.5, -27.4], b: [6.97, 15.9, -38], r: 3.2 },
  { name: 'lFoot', bone: 'b_LeftFoot01_017', a: [6.97, 15.9, -38], b: [6.97, 1, -32.9], r: 2.4 },
  { name: 'rThigh', bone: 'b_RightLeg01_019', a: [-6.97, 47, -30], b: [-6.97, 30.5, -27.4], r: 6 },
  { name: 'rShin', bone: 'b_RightLeg02_020', a: [-6.97, 30.5, -27.4], b: [-6.97, 15.9, -38], r: 3.2 },
  { name: 'rFoot', bone: 'b_RightFoot01_021', a: [-6.97, 15.9, -38], b: [-6.97, 1, -32.9], r: 2.4 },
  { name: 'tail1', bone: 'b_Tail01_012', a: [0, 52.6, -40.2], b: [0, 43.5, -48.6], r: 6 },
  { name: 'tail2', bone: 'b_Tail02_013', a: [0, 43.5, -48.6], b: [0, 28.1, -67.3], r: 6.5 },
  { name: 'tail3', bone: 'b_Tail03_014', a: [0, 28.1, -67.3], b: [0, 20.1, -86], r: 3.5 },
];

export interface FoxCharacterOptions {
  name: string;
  hair: HairSystem;
  params: HairParamsData;
  groom: FoxGroomParams;
  strandScale: number;
  guideScale: number;
  seed?: number;
}

/** A skinned, animated Khronos Fox with strand fur, walking a (shared) wobbly loop. */
export class FoxCharacter {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshPhysicalNodeMaterial;
  readonly mixer: THREE.AnimationMixer;
  readonly actions = new Map<string, THREE.AnimationAction>();
  readonly bones = new Map<string, THREE.Bone>();
  readonly colliders = new ColliderSet();
  readonly colliderDebug: ColliderDebug;
  hair!: HairInstance;
  animation: FoxAnimation = 'Walk';
  moving = true;
  /** The loop it walks (shared between foxes, which the example advances) and its place among them. */
  path = new FoxPath();
  pathIndex = 0;
  speedScale = 1;
  private readonly geometry: THREE.BufferGeometry;
  private readonly sampler: ReturnType<typeof createTextureSampler>;
  /** Downsampled (so blurred) lookup for strand colours: the painted fur strokes would show as dark streaks. */
  private readonly colorSampler: ReturnType<typeof createTextureSampler>;

  private readonly opts: FoxCharacterOptions;

  constructor(gltf: GLTF, opts: FoxCharacterOptions) {
    this.opts = opts;
    this.root.name = opts.name;
    this.model = SkeletonUtils.clone(gltf.scene);
    this.model.scale.setScalar(FOX_SCALE);
    this.root.add(this.model);
    let skinned: THREE.SkinnedMesh | null = null;
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = o as THREE.SkinnedMesh;
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
    });
    if (!skinned) throw new Error('Fox skinned mesh not found');
    this.mesh = skinned;

    // Weld (the source is non-indexed with no normals) and give it smooth seam-free normals.
    const src = this.mesh.geometry;
    const indexed = mergeVertices(src);
    const pos = indexed.getAttribute('position');
    const local = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) local.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
    indexed.setAttribute('normal', new THREE.BufferAttribute(weldedNormals(local, indexed.index!.array), 3));
    this.geometry = indexed;
    this.mesh.geometry = indexed;

    const srcMat = this.mesh.material as THREE.MeshStandardMaterial;
    this.material = new THREE.MeshPhysicalNodeMaterial({
      map: srcMat.map,
      // Dark like shadowed undercoat, so gaps between strands read as depth rather than bare skin.
      color: new THREE.Color(0.3, 0.27, 0.25),
      roughness: 0.95,
      specularIntensity: 0.15,
      envMapIntensity: 0.3,
    });
    this.mesh.material = this.material;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(OPAQUE_SHADOW_LAYER);
    this.sampler = srcMat.map ? createTextureSampler(srcMat.map) : null;
    this.colorSampler = srcMat.map ? createTextureSampler(srcMat.map, 12) : null;

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));

    // Groom in the rest pose at the origin (fur flow directions are authored in fox space).
    this.root.updateMatrixWorld(true);
    this.buildColliders();
    this.colliderDebug = new ColliderDebug(this.colliders);
    this.groom();
    this.setAnimation(this.animation, 0);
  }

  static async create(opts: FoxCharacterOptions): Promise<FoxCharacter> {
    return new FoxCharacter(await loadFox(), opts);
  }

  private buildColliders(): void {
    const inv = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const toBone = (bone: THREE.Bone, v: [number, number, number]) => {
      p.set(v[0], v[1], v[2]).applyMatrix4(this.model.matrixWorld);
      return p.clone().applyMatrix4(inv.copy(bone.matrixWorld).invert());
    };
    for (const c of CAPSULES) {
      const bone = this.bones.get(c.bone);
      if (!bone) continue;
      this.colliders.add({
        name: c.name,
        a: toBone(bone, c.a),
        b: toBone(bone, c.b),
        radius: c.r * FOX_SCALE,
        attach: bone,
      });
    }
  }

  /** (Re)grooms the fur; must be called with the fox in its rest pose at the origin. */
  groom(): void {
    const { source, growth } = skinnedGrowth(this.mesh, this.geometry);
    const g = this.opts.groom;
    const style = createFurStyle({
      lengthScale: g.lengthScale,
      lengthVariation: g.lengthVariation,
      guideCount: g.guideCount,
      strandCount: g.strandCount,
      guideParticles: g.guideParticles,
      strandPoints: g.strandPoints,
      regions: furRegions(g),
      boneRegion: BONE_REGION,
      sampleColor: this.colorSampler,
      sampleMask: this.sampler,
      // Near-black texels grow no fur.
      bareLuminance: 0.012,
      // Ears share the head bone; pick them out by height (model y > 66 cm in rest pose).
      regionOverride: (sp) => (sp.position.y > 66 * FOX_SCALE ? 'ear' : null),
    });
    const groomOpts = {
      seed: this.opts.seed ?? 3,
      strandScale: this.opts.strandScale,
      guideScale: this.opts.guideScale,
      collisionMargin: 0.002,
      rootColliderRange: 1,
    };
    if (this.hair) {
      this.hair.setStyle(style);
      this.hair.build(groomOpts);
      return;
    }
    this.hair = this.opts.hair.createInstance({
      name: this.opts.name,
      source,
      growth,
      style,
      colliders: this.colliders,
      paramObjects: { fur: this.opts.params },
      groom: groomOpts,
      boundsObject: this.bones.get('b_Hip_01') ?? this.model,
    });
    applyHairShadow(this.material, this.hair.shadowMap, this.hair.bodyShadowDensity);
  }

  /** Re-grooms in the rest pose, then restores the animated state. */
  regroom(): void {
    const saved = { pos: this.root.position.clone(), quat: this.root.quaternion.clone() };
    this.mixer.stopAllAction();
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.mesh.skeleton.pose();
    this.root.updateMatrixWorld(true);
    this.groom();
    this.root.position.copy(saved.pos);
    this.root.quaternion.copy(saved.quat);
    this.root.updateMatrixWorld(true);
    this.setAnimation(this.animation, 0);
  }

  setAnimation(name: FoxAnimation, fade = 0.35): void {
    const next = this.actions.get(name);
    if (!next) return;
    const prev = this.actions.get(this.animation);
    this.animation = name;
    next.reset().setEffectiveWeight(1).play();
    if (prev && prev !== next && fade > 0) prev.crossFadeTo(next, fade, false);
    else for (const [n, a] of this.actions) if (n !== name) a.stop();
  }

  get speed(): number {
    if (!this.moving) return 0;
    // Ground speed in m/s matched to each clip's stride: how fast a planted paw moves backwards relative to the
    // body (measured from the clips, about 0.69 for Walk and 1.23 for Run, then trimmed by eye).
    return (this.animation === 'Run' ? 1.2 : this.animation === 'Walk' ? 0.62 : 0) * this.speedScale;
  }

  /** Poses the fox on its path (call after the path has advanced this frame). */
  update(dt: number): void {
    const a = this.path.foxAngle(this.pathIndex);
    // The loop's length varies around it and the foxes drift ahead and back, so this fox's ground speed differs
    // a little from the nominal one: match the stride to it so the paws don't slide. Survey stands still, so
    // the speed slider doesn't apply.
    const v = this.speed;
    const stride = v > 0 ? (this.path.stride(a) * this.path.foxRate(this.pathIndex)) / v : 1;
    this.mixer.update(dt * (this.animation === 'Survey' ? 1 : this.speedScale * stride));
    this.path.point(a, this.root.position);
    // Face along the path (fox faces +Z in model space).
    this.root.rotation.y = this.path.heading(a);
    this.root.updateMatrixWorld(true);
    this.colliderDebug.update();
  }

  dispose(): void {
    this.opts.hair.remove(this.hair);
    this.colliderDebug.dispose();
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
