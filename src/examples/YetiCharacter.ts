import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { attribute, mix, texture, uniform, uv } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { ColliderSet } from '../hair/colliders';
import { createFurStyle, type FurRegion } from '../hair/groom/styles/furStyle';
import type { GroomStyle, SurfacePoint } from '../hair/groom/types';
import { skinnedGrowth } from '../hair/growth';
import type { HairInstance } from '../hair/HairInstance';
import type { HairSystem } from '../hair/HairSystem';
import type { HairParamsData } from '../hair/params';
import { ColliderDebug } from '../hair/render/ColliderDebug';
import { OPAQUE_SHADOW_LAYER, applyHairShadow } from '../hair/render/HairShadowPass';
import { bakeMeshSdf } from '../hair/sdf';
import { createTextureSampler } from '../util/texture';

/** Model units → meters: ~1.25 m to the top of the head, ~1.65 m with the antlers. */
export const YETI_SCALE = 0.034;

export type YetiMotion = 'idle' | 'still';

export interface YetiGroomParams {
  lengthScale: number;
  beardLength: number;
  lengthVariation: number;
  /** Amount of the violet spot pattern (0 = none). */
  spots: number;
  guideCount: number;
  strandCount: number;
  guideParticles: number;
  strandPoints: number;
}

export const defaultYetiGroom = (): YetiGroomParams => ({
  lengthScale: 1.8,
  beardLength: 0.12,
  lengthVariation: 0.55,
  spots: 0,
  guideCount: 3200,
  strandCount: 400000,
  guideParticles: 10,
  strandPoints: 8,
});

let gltfPromise: Promise<GLTF> | null = null;
export function loadYeti(): Promise<GLTF> {
  return (gltfPromise ??= new GLTFLoader().loadAsync('models/yeti/Yeti.gltf'));
}

/** Fur region for a joint of the Babylon.js Yeti skeleton. */
function regionForBone(name: string): string {
  if (/Tail/.test(name)) return 'tail';
  if (/Head/.test(name)) return 'head';
  if (/Neck/.test(name)) return 'neck';
  if (/Spine[56]/.test(name)) return 'chest';
  if (/Wrist|Index|Middle|Pinky|Thumb/.test(name)) return 'hand';
  if (/Elbow|Forearm/.test(name)) return 'forearm';
  if (/Clavicle|Arm$/.test(name)) return 'upperArm';
  if (/Ankle|Foot|Toe/.test(name)) return 'foot';
  if (/Leg|Knee/.test(name)) return 'leg';
  return 'body';
}

function furRegions(g: YetiGroomParams): Record<string, FurRegion> {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
  // Low lift and a strong bend towards the comb / gravity: long fur drapes down instead of sticking out.
  return {
    body: { length: 0.07, lift: 0.12, flow: v(0, -1, 0.1), bend: 10 },
    chest: { length: 0.075, lift: 0.12, flow: v(0, -1, 0.15), bend: 10 },
    beard: { length: g.beardLength, lift: 0.1, flow: v(0, -1, 0.35), bend: 11 },
    neck: { length: 0.06, lift: 0.15, flow: v(0, -1, 0), bend: 9 },
    head: { length: 0.04, lift: 0.12, flow: v(0, -0.2, -1), bend: 6 },
    face: { length: 0.018, lift: 0.15, flow: v(0, -0.6, 0.8), bend: 3 },
    // Very short fur on the muzzle just above the teeth (longer fur would hang over them).
    muzzle: { length: 0.006, lift: 0.1, flow: v(0, -0.6, 0.8), bend: 0 },
    // Short fur on the backs of the ears (their insides are bare).
    ear: { length: 0.012, lift: 0.1, flow: v(0, 0.2, -1), bend: 2 },
    upperArm: { length: 0.06, lift: 0.12, flow: v(0, -1, 0), bend: 10 },
    forearm: { length: 0.085, lift: 0.15, flow: v(0, -1, 0), bend: 10 },
    // Only the white wrist cuffs of the hands grow fur (palms and fingers are bare).
    hand: { length: 0.05, lift: 0.15, flow: v(0, -1, 0), bend: 8 },
    leg: { length: 0.065, lift: 0.12, flow: v(0, -1, 0), bend: 10 },
    foot: { length: 0.045, lift: 0.2, flow: v(0, -1, 0.3), bend: 6 },
    tail: { length: 0.08, lift: 0.15, flow: v(0, -1, -0.4), bend: 9 },
  };
}

/** Collision capsules between joints (radius fitted to the skin of `bones`), attached to `from`. */
const CAPSULES: {
  name: string;
  from: string;
  to: string | [string, [number, number, number]];
  bones: string[];
}[] = [
  {
    name: 'pelvis',
    from: 'Yeti_Hips',
    to: 'Yeti_Spine2',
    bones: ['Yeti_Hips', 'Yeti_Spine1', 'Yeti_Spine2'],
  },
  { name: 'belly', from: 'Yeti_Spine2', to: 'Yeti_Spine4', bones: ['Yeti_Spine3', 'Yeti_Spine4'] },
  { name: 'chest', from: 'Yeti_Spine4', to: 'Yeti_Spine6', bones: ['Yeti_Spine5', 'Yeti_Spine6'] },
  { name: 'neck', from: 'Yeti_Neck', to: 'Yeti_Head', bones: ['Yeti_Neck'] },
  { name: 'head', from: 'Yeti_Head', to: ['Yeti_Head', [0, 3.5, 0.8]], bones: ['Yeti_Head'] },
  ...(['Left', 'Right'] as const).flatMap((s) => [
    {
      name: `${s}UpperArm`,
      from: `Yeti_${s}Arm`,
      to: `Yeti_${s}Elbow`,
      bones: [`Yeti_${s}Arm`, `Yeti_${s}Clavicle`],
    },
    {
      name: `${s}Forearm`,
      from: `Yeti_${s}Elbow`,
      to: `Yeti_${s}Wrist`,
      bones: [`Yeti_${s}Elbow`, `Yeti_${s}Forearm`],
    },
    { name: `${s}Hand`, from: `Yeti_${s}Wrist`, to: `Yeti_${s}Middle2`, bones: [`Yeti_${s}Wrist`] },
    { name: `${s}Thigh`, from: `Yeti_${s}Leg`, to: `Yeti_${s}Knee`, bones: [`Yeti_${s}Leg`] },
    { name: `${s}Shin`, from: `Yeti_${s}Knee`, to: `Yeti_${s}Ankle`, bones: [`Yeti_${s}Knee`] },
    {
      name: `${s}Foot`,
      from: `Yeti_${s}Ankle`,
      to: `Yeti_${s}Toe`,
      bones: [`Yeti_${s}Ankle`, `Yeti_${s}Foot`, `Yeti_${s}Toe`],
    },
  ]),
  {
    name: 'tail',
    from: 'Yeti_TailBase',
    to: 'Yeti_TailTip',
    bones: ['Yeti_TailBase', 'Yeti_TailMid', 'Yeti_TailTip'],
  },
];

/** Smooth 3D value noise in [0, 1] (spot pattern). */
function valueNoise(x: number, y: number, z: number): number {
  const hash = (i: number, j: number, k: number) => {
    const h = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const fx = s(x - xi);
  const fy = s(y - yi);
  const fz = s(z - zi);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

export interface YetiCharacterOptions {
  name: string;
  hair: HairSystem;
  params: HairParamsData;
  groom: YetiGroomParams;
  strandScale: number;
  guideScale: number;
}

/** The Babylon.js Yeti (CC BY 4.0) with strand fur grown on its body, playing its idle animation. */
export class YetiCharacter {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshPhysicalNodeMaterial;
  readonly mixer: THREE.AnimationMixer;
  readonly idle: THREE.AnimationAction | null;
  readonly bones = new Map<string, THREE.Bone>();
  readonly colliders = new ColliderSet();
  readonly colliderDebug: ColliderDebug;
  /** Skin colour under the fur (synced from the fur's root colour). */
  readonly furTint = uniform(new THREE.Color('#b3c3cf'));
  hair!: HairInstance;
  motion: YetiMotion = 'idle';
  speed = 1;
  private readonly geometry: THREE.BufferGeometry;
  private readonly sampler: ReturnType<typeof createTextureSampler>;
  private readonly colorSampler: ReturnType<typeof createTextureSampler>;
  private readonly furMask: THREE.BufferAttribute;
  /** Where fur grows (0..1, before the length-based strand density). */
  private coverage: (sp: SurfacePoint) => number = () => 1;
  /** Where the skin takes the fur's colour (the fur coverage plus bare spots that should read as fur). */
  private furSkin: (sp: SurfacePoint) => number = () => 1;
  /** Bone transforms as loaded (the rest pose; skeleton.pose() would use this file's mesh-space bind matrices). */
  private readonly rest: { bone: THREE.Bone; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = [];

  private readonly opts: YetiCharacterOptions;

  constructor(gltf: GLTF, opts: YetiCharacterOptions) {
    this.opts = opts;
    this.root.name = opts.name;
    this.model = gltf.scene;
    this.model.scale.setScalar(YETI_SCALE);
    this.root.add(this.model);
    let body: THREE.SkinnedMesh | null = null;
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      // Zero-weight joint indices sometimes equal the joint count; clamp them so they stay in range.
      const si = m.geometry.getAttribute('skinIndex');
      const sw = m.geometry.getAttribute('skinWeight');
      const joints = m.skeleton.bones.length;
      for (let i = 0; i < si.count; i++)
        for (let k = 0; k < 4; k++)
          if (si.getComponent(i, k) >= joints && sw.getComponent(i, k) === 0) si.setComponent(i, k, 0);
      si.needsUpdate = true;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      if (m.name === 'YetiBody_low') body = m;
      // The sculpted beard and forearm tufts are replaced by real fur.
      if (m.name === 'YetiBeard_low' || m.name === 'YetiFur_low') m.visible = false;
    });
    if (!body) throw new Error('Yeti body mesh not found');
    for (const bone of this.bones.values())
      this.rest.push({ bone, p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() });
    this.mesh = body;
    this.geometry = this.mesh.geometry;

    const src = this.mesh.material as THREE.MeshStandardMaterial;
    this.furMask = new THREE.BufferAttribute(
      new Float32Array(this.geometry.getAttribute('position').count),
      1,
    );
    this.geometry.setAttribute('furMask', this.furMask);
    this.material = new THREE.MeshPhysicalNodeMaterial({
      normalMap: src.normalMap,
      roughnessMap: src.roughnessMap,
      roughness: 0.9,
      metalness: 0,
      specularIntensity: 0.25,
      envMapIntensity: 0.35,
    });
    // Where fur grows (furMask) the skin takes a darkened fur root colour, so gaps between strands read as
    // undercoat. Bare skin (hands, feet, face) keeps its texture.
    if (src.map)
      this.material.colorNode = mix(
        texture(src.map, uv()).rgb,
        this.furTint.mul(0.7),
        attribute('furMask', 'float'),
      );
    this.mesh.material = this.material;
    this.mesh.layers.enable(OPAQUE_SHADOW_LAYER);
    this.sampler = src.map ? createTextureSampler(src.map) : null;
    this.colorSampler = src.map ? createTextureSampler(src.map, 8) : null;

    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = gltf.animations.find((a) => a.name === 'Idle') ?? gltf.animations[0];
    this.idle = clip ? this.mixer.clipAction(clip) : null;

    this.toRestPose();
    this.buildColliders();
    this.colliderDebug = new ColliderDebug(this.colliders);
    this.colliderDebug.group.visible = false;
    this.groom();
    this.idle?.play();
  }

  private toRestPose(): void {
    for (const r of this.rest) {
      r.bone.position.copy(r.p);
      r.bone.quaternion.copy(r.q);
      r.bone.scale.copy(r.s);
    }
    this.root.updateMatrixWorld(true);
  }

  static async create(opts: YetiCharacterOptions): Promise<YetiCharacter> {
    return new YetiCharacter(await loadYeti(), opts);
  }

  private buildColliders(): void {
    const pos = this.geometry.getAttribute('position');
    const si = this.geometry.getAttribute('skinIndex');
    const sw = this.geometry.getAttribute('skinWeight');
    const boneIndex = new Map(this.mesh.skeleton.bones.map((b, i) => [b.name, i]));
    const world = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const inv = new THREE.Matrix4();
    const jointPos = (spec: string | [string, [number, number, number]], out: THREE.Vector3) => {
      const [name, offset] = typeof spec === 'string' ? [spec, [0, 0, 0] as [number, number, number]] : spec;
      const bone = this.bones.get(name);
      if (!bone) return false;
      bone.getWorldPosition(out);
      out.add(new THREE.Vector3(...offset).multiplyScalar(YETI_SCALE));
      return true;
    };
    for (const c of CAPSULES) {
      const attach = this.bones.get(c.from);
      if (!attach || !jointPos(c.from, a) || !jointPos(c.to, b)) continue;
      const ids = new Set(c.bones.map((n) => boneIndex.get(n)).filter((i): i is number => i !== undefined));
      const dists: number[] = [];
      ab.subVectors(b, a);
      const len2 = Math.max(ab.lengthSq(), 1e-9);
      for (let i = 0; i < pos.count; i++) {
        // Dominant joint of this vertex.
        let best = 0;
        for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
        if (!ids.has(si.getComponent(i, best))) continue;
        this.mesh.getVertexPosition(i, world).applyMatrix4(this.mesh.matrixWorld);
        const t = THREE.MathUtils.clamp(world.clone().sub(a).dot(ab) / len2, 0, 1);
        dists.push(world.distanceTo(a.clone().addScaledVector(ab, t)));
      }
      if (dists.length < 8) continue;
      dists.sort((x, y) => x - y);
      // Inside the skin: the body SDF keeps fur on the skin; the capsules only catch deep penetrations.
      const radius = dists[Math.floor(dists.length * 0.3)];
      inv.copy(attach.matrixWorld).invert();
      this.colliders.add({
        name: c.name,
        a: a.clone().applyMatrix4(inv),
        b: b.clone().applyMatrix4(inv),
        radius,
        attach,
      });
    }
    this.bakeBodySdf();
  }

  /**
   * Accurate body collisions: a narrow-band SDF of the skin that follows the skeleton every frame, so fur
   * rests on the body's actual (moving) shape. Capsules alone sit inside the bulges of the back and
   * shoulders, and fur hanging over a bulge would sink under the skin and leave a bare slit below it.
   */
  private bakeBodySdf(): void {
    const g = this.geometry;
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    if (!g.index || !nrm) return;
    const metersPerUnit = this.mesh.matrixWorld.getMaxScaleOnAxis();
    // The grid holds both the bind-pose skin (rest SDF) and the posed skin (refreshed SDF): cover the idle
    // animation's whole range of poses.
    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
    if (this.idle) {
      const v = new THREE.Vector3();
      const duration = this.idle.getClip().duration;
      this.idle.play();
      for (let i = 0; i <= 10; i++) {
        this.mixer.setTime((duration * i) / 10);
        this.root.updateMatrixWorld(true);
        for (let k = 0; k < pos.count; k += 2) box.expandByPoint(this.mesh.getVertexPosition(k, v));
      }
      this.idle.stop();
      this.toRestPose();
    }
    const band = 0.05 / metersPerUnit;
    box.expandByScalar(band);
    const positions = new Float32Array(pos.count * 3);
    const normals = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
      normals.set([nrm.getX(i), nrm.getY(i), nrm.getZ(i)], i * 3);
    }
    const grid = bakeMeshSdf(
      positions,
      normals,
      g.index.array,
      box.min,
      box.max,
      0.02 / metersPerUnit,
      band,
      undefined,
      // closestVertex: setSdf skins the grid through it.
      true,
    );
    // Each cell is skinned through its closest vertex; infinite padding refreshes the whole grid every frame.
    this.colliders.setSdf(grid, this.mesh, { mesh: this.mesh, padding: Infinity });
  }

  private furStyle(): GroomStyle {
    const g = this.opts.groom;
    const q = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const faceFlow = new THREE.Vector3();
    const sm = THREE.MathUtils.smoothstep;
    const handFootBones = new Set(
      this.mesh.skeleton.bones.flatMap((b, i) =>
        /Wrist|Index|Middle|Pinky|Thumb|Ankle|Foot|Toe/.test(b.name) ? [i] : [],
      ),
    );
    // Landmarks in model units (bind pose): the mouth's lower lip tops out at y ≈ 31, the neck crease under the
    // jaw is at y ≈ 23, the eye sockets are at |x| 1.5–4, y 33.5–35.5 and the ears sit at |x| ≈ 6.5, z ≈ −4.
    const toModel = (sp: SurfacePoint) => q.copy(sp.position).divideScalar(YETI_SCALE);
    /** The beard covers the jaw, from the neck crease up to the lower lip, and fades into the body fur. */
    const beardWeight = (sp: SurfacePoint) => {
      const m = toModel(sp);
      return (
        sm(m.y, 22, 24.5) *
        (1 - sm(m.y, 30.9, 31.5)) *
        (1 - sm(Math.abs(m.x), 6.5, 10)) *
        sm(sp.normal.z, -0.15, 0.25) *
        sm(m.z, 1, 4)
      );
    };
    /** Top of the lower lip, in front of the teeth: no fur (it would point up across the teeth). */
    const lipTop = (sp: SurfacePoint) => {
      const m = toModel(sp);
      return Math.abs(m.x) < 7 && m.y > 30.6 && m.y < 32 && m.z > 4.2 && sp.normal.y > 0.4;
    };
    /** The skin beside and under the nose, level with the upper teeth. */
    const muzzleWeight = (sp: SurfacePoint) => {
      const m = toModel(sp);
      return (
        sm(m.y, 30.9, 31.4) * (1 - sm(m.y, 32.5, 33.3)) * (1 - sm(Math.abs(m.x), 5.5, 7)) * sm(m.z, 3.2, 4.2)
      );
    };
    /** Ears: an ellipsoid around each (0 outside, 1 well inside). */
    const earWeight = (sp: SurfacePoint) => {
      const m = toModel(sp);
      const ex = (Math.abs(m.x) - 6.4) / 2;
      const ey = (m.y - 33.7) / 2.1;
      const ez = (m.z + 4.2) / 2.9;
      return 1 - sm(Math.sqrt(ex * ex + ey * ey + ez * ez), 0.9, 1.1);
    };
    /** Short fur around the nose and eyes (the cheeks and forehead keep the longer head fur). */
    const faceWeight = (sp: SurfacePoint) => {
      const m = toModel(sp);
      return (
        sm(m.y, 31, 32) *
        (1 - sm(m.y, 35.5, 37)) *
        (1 - sm(Math.abs(m.x), 5, 7.5)) *
        sm(sp.normal.z, 0.05, 0.4)
      );
    };
    const style = createFurStyle({
      lengthScale: g.lengthScale,
      lengthVariation: g.lengthVariation,
      guideCount: g.guideCount,
      strandCount: g.strandCount,
      guideParticles: g.guideParticles,
      strandPoints: g.strandPoints,
      regions: furRegions(g),
      boneRegion: this.mesh.skeleton.bones.map((b) => regionForBone(b.name)),
      sampleColor: this.colorSampler,
      sampleMask: this.sampler,
      bareLuminance: 0.1,
      // The beard hangs from under the chin. Elsewhere fur keeps lying along the skin: fur standing out of the
      // undersides of the back's bulges would open slits in the coat as the shoulders move.
      hang: (sp) => 0.75 * beardWeight(sp),
      gravityBend: 0.6,
      interpSpace: 'world',
      // Short fur needs more strands to cover the skin as well as the long body fur.
      densityForLength: (length) => Math.min(1, Math.pow(0.05 / length, 0.5)),
      // Face and beard share the head / neck / spine bones: blend them in by position.
      regionOverride: (sp: SurfacePoint) => [
        { name: 'beard', weight: beardWeight(sp) },
        { name: 'face', weight: faceWeight(sp) },
        { name: 'muzzle', weight: muzzleWeight(sp) },
        { name: 'ear', weight: earWeight(sp) },
      ],
      flowField: (sp: SurfacePoint, flow: THREE.Vector3) => {
        const m = toModel(sp);
        // A little outwards from the body's axis: where the comb is nearly parallel to the normal (tops of the
        // shoulders, undersides) the fur still gets a consistent direction instead of an arbitrary one.
        radial.set(m.x, 0, m.z);
        if (radial.lengthSq() > 1e-6) flow.addScaledVector(radial.normalize(), 0.45);
        // Face fur sweeps outwards from the nose; just above the teeth it runs sideways instead of over them.
        // (Not the long beard at the corners of the mouth: that would stick out like whiskers.)
        const face = faceWeight(sp) * (1 - beardWeight(sp));
        if (face > 0) {
          const side = THREE.MathUtils.clamp(m.x / 1.5, -1, 1);
          const aboveTeeth = sm(m.y, 31.2, 31.8) * (1 - sm(m.y, 32.6, 33.4));
          faceFlow.set(side, -0.7 * (1 - aboveTeeth), 0.15).normalize();
          flow.lerp(faceFlow, face);
        }
      },
      densityOverride: (this.coverage = (sp: SurfacePoint) => {
        const m = toModel(sp);
        let handOrFoot = 0;
        for (const [bone, w] of sp.bones ?? []) if (handFootBones.has(bone)) handOrFoot += w;
        const texture = () => {
          if (!this.sampler || !sp.uv) return 1;
          const c = this.sampler(sp.uv.x, sp.uv.y);
          return sm(c[0] / Math.max(c[2], 1e-4), 0.55, 0.7);
        };
        // Bare: the insides of the ears (painted blue; their white backs get short fur), the nose and the top
        // of the lower lip.
        if (earWeight(sp) > 0.5) return texture();
        const nx = m.x / 1.8;
        const ny = (m.y - 32.5) / 1.15;
        if (nx * nx + ny * ny < 1 && m.z > 4.85) return 0;
        if (lipTop(sp)) return 0;
        // Inside the mouth: skin just behind the teeth (their front follows an arc, z ≈ 6.1 at the centre and
        // ≈ 3.4 at |x| = 5.5; the mouth is no deeper than z ≈ 1) is bare, so nothing grows from between them.
        if (Math.abs(m.x) < 6.3 && m.y > 29.4 && m.y < 32.2 && m.z > 1 && m.z < 6.3 - 0.09 * m.x * m.x)
          return 0;
        // The texture's blue marks bare skin on the palms, fingers and toes (the white cuffs are fur) and in the
        // eye sockets. Elsewhere its bluish brush strokes are painted fur, not skin.
        if (handOrFoot > 0.3) return texture();
        if (Math.abs(m.x) < 4.4 && m.y > 33.1 && m.y < 35.9 && m.z > 1) return texture();
        return 1;
      }),
      tint: (sp, rgb) => {
        if (g.spots <= 0) return rgb;
        q.copy(sp.position).divideScalar(YETI_SCALE).multiplyScalar(0.22);
        const n = valueNoise(q.x, q.y, q.z) * 0.65 + valueNoise(q.x * 2.1 + 7, q.y * 2.1, q.z * 2.1) * 0.35;
        const spot = g.spots * THREE.MathUtils.smoothstep(n, 0.6, 0.68);
        return [rgb[0] * (1 - 0.45 * spot), rgb[1] * (1 - 0.7 * spot), rgb[2] * (1 - 0.15 * spot)];
      },
    });
    // The lip top takes the fur colour so the fur seems to run right up to the teeth.
    this.furSkin = (sp) => (lipTop(sp) ? 1 : this.coverage(sp));
    return style;
  }

  /** (Re)grooms the fur; must be called in the rest pose. */
  groom(): void {
    const { source, growth } = skinnedGrowth(this.mesh, this.geometry);
    const style = this.furStyle();
    // Bake the fur coverage into the body shading (dark undercoat only where fur grows).
    const uvAttr = this.geometry.getAttribute('uv');
    const sp: SurfacePoint = {
      tri: 0,
      u: 1,
      v: 0,
      w: 0,
      position: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      uv: new THREE.Vector2(),
      bones: new Map(),
    };
    for (let i = 0; i < this.furMask.count; i++) {
      if (uvAttr) sp.uv!.set(uvAttr.getX(i), uvAttr.getY(i));
      sp.position.fromArray(growth.positions, i * 3);
      sp.normal.fromArray(growth.normals, i * 3);
      sp.bones!.clear();
      for (let k = 0; k < 4; k++) {
        const w = growth.skinWeight![i * 4 + k];
        if (w > 0)
          sp.bones!.set(growth.skinIndex![i * 4 + k], (sp.bones!.get(growth.skinIndex![i * 4 + k]) ?? 0) + w);
      }
      this.furMask.setX(i, this.furSkin(sp));
    }
    this.furMask.needsUpdate = true;
    const groomOpts = {
      seed: 11,
      strandScale: this.opts.strandScale,
      guideScale: this.opts.guideScale,
      collisionMargin: 0.003,
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
      boundsObject: this.bones.get('Yeti_Hips') ?? this.model,
    });
    applyHairShadow(this.material, this.hair.shadowMap, this.hair.bodyShadowDensity);
  }

  /** Re-grooms in the rest pose at the origin, then resumes the animation. */
  regroom(): void {
    const saved = this.root.position.clone();
    this.mixer.stopAllAction();
    this.root.position.set(0, 0, 0);
    this.toRestPose();
    this.groom();
    this.root.position.copy(saved);
    this.root.updateMatrixWorld(true);
    this.idle?.reset().play();
  }

  update(dt: number): void {
    if (this.idle) this.idle.paused = this.motion === 'still';
    this.mixer.update(dt * this.speed);
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    this.opts.hair.remove(this.hair);
    this.root.removeFromParent();
    this.material.dispose();
  }
}
