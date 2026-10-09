import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three/webgpu';

import { BeatFollower } from '../audio/beatFollower';
import { ColliderSet } from '../hair/colliders';
import {
  createMulletStyle,
  defaultMulletStyle,
  scalpMask,
  type MulletStyleParams,
} from '../hair/groom/styles/mulletStyle';
import { skinnedGrowth } from '../hair/growth';
import type { HairInstance } from '../hair/HairInstance';
import type { HairSystem } from '../hair/HairSystem';
import { mergeHairParams, type HairParamsData } from '../hair/params';
import { ColliderDebug } from '../hair/render/ColliderDebug';
import { OPAQUE_SHADOW_LAYER, applyHairShadow } from '../hair/render/HairShadowPass';
import { bakeMeshSdf } from '../hair/sdf';
import { tsl } from '../hair/sim/tsl';
import { Inertializer } from '../util/inertialize';
import { createPedestal } from './Pedestal';

const { attribute, mix, texture, uniform, uv } = tsl;

/** Model units → meters (≈0.25 m chin to crown). */
export const LPS_SCALE = 0.053;
/** Model y of the bust's flat bottom. */
const LPS_BOTTOM = -3.973;
/** Model-space point (x, z) under the torso, nudged towards the neck: the pedestal is centred here. */
const LPS_BASE_X = 0;
const LPS_BASE_Z = -0.6;
/** Half-width of the pedestal top in meters (slimmer than the shoulders, like a museum bust pedestal). */
const PEDESTAL_TOP_HALF_WIDTH = 0.13;

export type HeadMotion = 'still' | 'idle' | 'nod' | 'headbang' | 'roxbury' | 'lookAround';
export type MulletGroomParams = Omit<MulletStyleParams, 'modelScale' | 'modelOrigin'>;
export const defaultMulletGroom = defaultMulletStyle;

interface HeadAssets {
  geometry: THREE.BufferGeometry;
  map: THREE.Texture;
  normalMap: THREE.Texture;
  specMap: THREE.Texture;
}

let assetsPromise: Promise<HeadAssets> | null = null;
export function loadHead(): Promise<HeadAssets> {
  return (assetsPromise ??= (async () => {
    const base = 'models/lee-perry-smith/';
    const tl = new THREE.TextureLoader();
    const [gltf, map, normalMap, specMap] = await Promise.all([
      new GLTFLoader().loadAsync(`${base}LeePerrySmith.glb`),
      tl.loadAsync(`${base}Map-COL.jpg`),
      tl.loadAsync(`${base}Infinite-Level_02_Tangent_SmoothUV.jpg`),
      tl.loadAsync(`${base}Map-SPEC.jpg`),
    ]);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    const mesh = gltf.scene.children[0] as THREE.Mesh;
    return { geometry: mesh.geometry, map, normalMap, specMap };
  })());
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export type MulletParams = { business: HairParamsData; party: HairParamsData };

/** Hair defaults per groom group: business (front and top) and party (back). */
export function createMulletParams(substeps: number): MulletParams {
  const shading = {
    rootColor: '#2a1a10',
    tipColor: '#8b6440',
    gradientStart: 0.05,
    gradientEnd: 1,
    textureInfluence: 0,
    hueJitter: 0.03,
    valueJitter: 0.22,
    specular: 0.55,
    roughness: 0.32,
    shift: 0.04,
    backlit: 0.7,
    scatter: 0.65,
    selfShadowDensity: 380,
    aoRoot: 0.3,
    aoRange: 0.3,
    tipFade: 0.2,
  };
  const style = {
    rootWidth: 0.00015,
    tipWidth: 0.00005,
    taper: 1.3,
    clump: 0.25,
    clumpShape: 1.4,
    frizz: 0.0004,
    frizzFrequency: 6,
    lodStrandsPerPixel: 8,
  };
  return {
    business: mergeHairParams({
      // Reactive, not floppy or jiggly: strong bend stiffness keeps the cut, a softer style hold and
      // little root-following let it lag the head, and enough damping settles it within one swing.
      physics: {
        substeps,
        globalStiffness: 0.32,
        globalTip: 0.5,
        localStiffness: 0.8,
        localTip: 0.65,
        damping: 9,
        drag: 3,
        followRoot: 0.12,
        collisionMargin: 0.003,
        collisionFriction: 0.3,
      },
      // Render strands collide too (strands between guides would otherwise cut through the ears).
      style: { ...style, collide: true },
      shading,
    }),
    party: mergeHairParams({
      // A strong style hold over the top of the party (late falloff, limited range) keeps it full under the
      // business crown, so the two blend; below the range the lengths hang free and swing.
      physics: {
        substeps,
        globalStiffness: 0.3,
        globalTip: 0.0,
        globalCurve: 3,
        globalRange: 0.45,
        localStiffness: 0.45,
        localTip: 0.3,
        damping: 1.0,
        drag: 2.0,
        followRoot: 0.0,
        collisionMargin: 0.004,
        collisionFriction: 0.35,
      },
      // Textured, wavy locks rather than a flat sheet (also softens the edge against the crown).
      style: {
        ...style,
        collide: true,
        clump: 0.36,
        clumpShape: 1.2,
        curlRadius: 0.0032,
        curlTurns: 3.5,
        curlRamp: 0.35,
        frizz: 0.0009,
        frizzFrequency: 5,
      },
      shading,
    }),
  };
}

export interface MulletCharacterOptions {
  name: string;
  hair: HairSystem;
  params: MulletParams;
  groom: MulletGroomParams;
  strandScale: number;
  guideScale: number;
  /** Height of the pedestal top (bust bottom) in meters. */
  plinthHeight: number;
}

/** Lee Perry-Smith bust with a procedural neck rig and a simulated mullet. */
export class MulletCharacter {
  readonly root = new THREE.Group();
  readonly bust = new THREE.Group();
  readonly plinth: THREE.Mesh;
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshPhysicalNodeMaterial;
  readonly chest = new THREE.Bone();
  readonly neck = new THREE.Bone();
  readonly head = new THREE.Bone();
  readonly colliders = new ColliderSet();
  readonly colliderDebug: ColliderDebug;
  hair!: HairInstance;
  motion: HeadMotion = 'idle';
  /** Motion tempo in beats per second when no music clock is attached. */
  tempo = 2.1;
  amount = 1;
  /** Music beat clock (beat count and beats/s) — when it returns a value, motions follow its beat. */
  beatClock: (() => { beat: number; rate: number } | null) | null = null;
  /** Bang every N beats. */
  beatDivision = 1;
  /** Amplitude multiplier from the music's loudness, applied while the beat clock runs. */
  loudness: (() => number) | null = null;
  private time = 0;
  /** Bang count; eases onto the music's beat instead of jumping when the tempo, track or division changes. */
  private readonly bangs = new BeatFollower();
  /** Look-around phase, advanced by the tempo slider so slider changes don't jump it. */
  private lookPhase = 0;
  /** Neck/head angles (pitch, yaw, roll, head lag), inertialized when the motion or its clock changes. */
  private readonly angles = new Inertializer(4);
  private readonly target = [0, 0, 0, 0];
  private readonly targetBefore = [0, 0, 0, 0];
  /** Last frame's clock inputs, to evaluate a newly picked motion one frame back (its velocity). */
  private readonly last = { bangs: 0, time: 0, look: 0 };
  private lastClock: 'music' | 'free' = 'free';
  private lastMotion: HeadMotion = 'idle';
  private readonly geometry: THREE.BufferGeometry;
  private readonly scalpAttr: THREE.BufferAttribute;
  readonly scalpTint = uniform(new THREE.Color('#2a1a10'));

  private readonly opts: MulletCharacterOptions;

  constructor(assets: HeadAssets, opts: MulletCharacterOptions) {
    this.opts = opts;
    this.root.name = opts.name;
    this.root.position.y = opts.plinthHeight;
    this.bust.scale.setScalar(LPS_SCALE);
    this.bust.position.set(-LPS_BASE_X * LPS_SCALE, -LPS_BOTTOM * LPS_SCALE, -LPS_BASE_Z * LPS_SCALE);
    this.root.add(this.bust);

    // Museum pedestal; its top is the bust's base.
    this.plinth = createPedestal({ height: opts.plinthHeight, topHalfWidth: PEDESTAL_TOP_HALF_WIDTH });
    this.plinth.castShadow = true;
    this.plinth.receiveShadow = true;
    this.plinth.layers.enable(OPAQUE_SHADOW_LAYER);
    opts.hair.registerShadowReceiver(this.plinth.material as THREE.NodeMaterial);
    this.root.add(this.plinth);

    // Procedural neck rig: chest → neck → head, weighted along a slanted jaw-to-nape plane.
    const geometry = assets.geometry.clone();
    const pos = geometry.getAttribute('position');
    const n = pos.count;
    const skinIndex = new Uint16Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      // The scan's midline is at x ≈ −0.08.
      const x = pos.getX(i) + 0.08;
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const jawLine = -0.438 - 0.385 * z;
      let wHead = smoothstep(jawLine - 0.3, jawLine + 0.35, y);
      let wChest = 1 - smoothstep(-2.0, -1.25, y + 0.3 * Math.max(Math.abs(x) - 1.0, 0));
      wChest = Math.min(wChest, 1 - wHead);
      const wNeck = Math.max(0, 1 - wHead - wChest);
      const sum = wHead + wChest + wNeck;
      wHead /= sum;
      wChest /= sum;
      skinIndex.set([0, 1, 2, 0], i * 4);
      skinWeight.set([wChest, wNeck / sum, wHead, 0], i * 4);
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    this.scalpAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
    geometry.setAttribute('scalp', this.scalpAttr);
    this.geometry = geometry;

    this.chest.position.set(-0.08, -2.2, -0.45);
    this.neck.position.set(0, 1.0, 0);
    this.head.position.set(0, 1.4, 0.05);
    this.chest.add(this.neck);
    this.neck.add(this.head);

    // Skin material with the scan textures; the scalp under the hair is tinted towards the root color.
    this.material = new THREE.MeshPhysicalNodeMaterial({
      normalMap: assets.normalMap,
      roughness: 0.55,
      specularIntensity: 0.4,
      envMapIntensity: 0.55,
    });
    const tex = texture(assets.map, uv());
    const scalp = attribute('scalp', 'float');
    this.material.colorNode = mix(tex.rgb, this.scalpTint.mul(0.8), scalp.mul(0.7));
    // Less specular where hair covers the scalp (dark tinted skin otherwise mirrors the blue rim light).
    this.material.specularIntensityNode = mix(0.4, 0.08, scalp);
    this.mesh = new THREE.SkinnedMesh(geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(OPAQUE_SHADOW_LAYER);
    this.mesh.add(this.chest);
    this.bust.add(this.mesh);
    this.root.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton([this.chest, this.neck, this.head]), this.mesh.matrixWorld);

    this.buildColliders();
    this.colliderDebug = new ColliderDebug(this.colliders);
    this.groom();
  }

  static async create(opts: MulletCharacterOptions): Promise<MulletCharacter> {
    return new MulletCharacter(await loadHead(), opts);
  }

  private buildColliders(): void {
    const toBone = (bone: THREE.Bone, v: [number, number, number]) => {
      const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(this.bust.matrixWorld);
      return p.applyMatrix4(bone.matrixWorld.clone().invert());
    };
    const add = (
      name: string,
      bone: THREE.Bone,
      a: [number, number, number],
      b: [number, number, number],
      r: number,
    ) =>
      this.colliders.add({
        name,
        a: toBone(bone, a),
        b: toBone(bone, b),
        radius: r * LPS_SCALE,
        attach: bone,
      });
    add('cranium', this.head, [-0.073, 2.2, 0.0], [-0.073, 2.1, 0.15], 1.72);
    add('face', this.head, [-0.08, 1.3, 1.05], [-0.08, -0.2, 1.2], 0.95);
    add('jaw', this.head, [-0.08, 0.5, 0.2], [-0.08, -0.45, 0.55], 1.1);
    // The ears stop just below the hairline: roots inside a collider ignore it, so hair growing right above
    // the ear would otherwise fall straight through it.
    add('earL', this.head, [1.68, 0.95, -0.1], [1.68, 1.72, -0.12], 0.32);
    add('earR', this.head, [-1.82, 0.95, -0.1], [-1.82, 1.72, -0.12], 0.32);
    add('neck', this.neck, [-0.08, -0.4, -0.45], [-0.08, -1.6, -0.6], 1.12);
    this.bakeTorsoSdf();
  }

  /**
   * Accurate collisions for the bust (shoulders, back, chest): a narrow-band SDF baked from the
   * scan, unioned with the plinth top so long hair can rest on the ledge instead of sinking into
   * it. The base of the neck is partly skinned to the neck bone, so that part of the SDF follows
   * the skinning every frame (otherwise hair clips into it when the head pitches forward).
   */
  private bakeTorsoSdf(): void {
    const g = this.geometry;
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const skinIndex = g.getAttribute('skinIndex');
    const skinWeight = g.getAttribute('skinWeight');
    const positions = new Float32Array(pos.count * 3);
    const normals = new Float32Array(pos.count * 3);
    // Dense weights per bone (chest, neck, head).
    const weights = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
      normals.set([nrm.getX(i), nrm.getY(i), nrm.getZ(i)], i * 3);
      for (let k = 0; k < 4; k++)
        weights[i * 4 + skinIndex.getComponent(i, k)] += skinWeight.getComponent(i, k);
    }
    // Covers the shoulders, back and chest (the pedestal has its own collider: the bust can be dragged off it).
    const min = new THREE.Vector3(-4.8, -5.6, -4.8);
    const max = new THREE.Vector3(4.8, -0.9, 1.5);
    const grid = bakeMeshSdf(positions, normals, g.index!.array, min, max, 0.12, 0.7, weights);
    // The neck tilts up to ~0.5 rad, moving the skin at its base by under 3 cm (padding 0.6 model units ≈ 3.2 cm).
    this.colliders.setSdf(grid, this.mesh, { mesh: this.mesh, padding: 0.6 });
    // Pedestal top: a rounded box that stays with the pedestal, so long hair rests on its ledge.
    const slab = 0.05;
    const top = new THREE.Object3D();
    top.position.set(0, -slab, 0);
    this.plinth.add(top);
    this.plinth.updateMatrixWorld(true);
    this.colliders.setShape(
      'box',
      new THREE.Vector4(PEDESTAL_TOP_HALF_WIDTH, slab, PEDESTAL_TOP_HALF_WIDTH, 0.006),
      top,
    );
  }

  /** (Re)grooms in the rest pose. */
  groom(): void {
    const saved = [this.neck.quaternion.clone(), this.head.quaternion.clone()];
    this.neck.quaternion.identity();
    this.head.quaternion.identity();
    this.root.updateMatrixWorld(true);
    const { source, growth } = skinnedGrowth(this.mesh, this.geometry);
    const style = createMulletStyle({
      ...this.opts.groom,
      modelScale: LPS_SCALE,
      modelOrigin: this.bust.getWorldPosition(new THREE.Vector3()),
    });
    // Scalp tint attribute (bind-pose world positions match the style's expectations).
    this.scalpAttr.array.set(scalpMask(style, growth.positions, growth.normals));
    this.scalpAttr.needsUpdate = true;
    const groomOpts = {
      seed: 11,
      strandScale: this.opts.strandScale,
      guideScale: this.opts.guideScale,
      collisionMargin: 0.003,
    };
    if (this.hair) {
      this.hair.setStyle(style);
      this.hair.build(groomOpts);
    } else {
      this.hair = this.opts.hair.createInstance({
        name: this.opts.name,
        source,
        growth,
        style,
        colliders: this.colliders,
        paramObjects: this.opts.params,
        groom: groomOpts,
        boundsObject: this.head,
      });
      applyHairShadow(this.material, this.hair.shadowMap, this.hair.bodyShadowDensity);
    }
    this.neck.quaternion.copy(saved[0]);
    this.head.quaternion.copy(saved[1]);
    this.root.updateMatrixWorld(true);
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    const music = this.beatClock?.() ?? null;
    const division = Math.max(0.25, this.beatDivision);
    // Continuous "bang" count: follows the music when available, else free-runs at the tempo slider.
    const b = music
      ? this.bangs.update(dt, music.rate / division, music.beat / division)
      : this.bangs.update(dt, this.tempo);
    this.lookPhase += dt * this.tempo;
    const a = this.amount * (music ? (this.loudness?.() ?? 1) : 1);
    this.pose(this.motion, b, t, this.lookPhase, a, this.target);

    // Picking another motion changes the curve, and starting or stopping the music changes the amplitude
    // (loudness): inertialize so the head keeps its momentum into the new motion. `bangs` eases phase changes.
    const clock = music ? 'music' : 'free';
    let switchedFrom: number[] | undefined;
    if (clock !== this.lastClock || this.motion !== this.lastMotion) {
      const { bangs, time, look } = this.last;
      this.pose(this.motion, bangs, time, look, a, this.targetBefore);
      switchedFrom = this.targetBefore;
      this.lastClock = clock;
      this.lastMotion = this.motion;
    }
    const [pitch, yaw, roll, lag] = this.angles.update(dt, this.target, switchedFrom);
    this.last.bangs = b;
    this.last.time = t;
    this.last.look = this.lookPhase;

    this.neck.rotation.set(pitch * 0.42, yaw * 0.4, roll * 0.4);
    this.head.rotation.set((pitch + lag) * 0.58, yaw * 0.6, roll * 0.6);
    this.root.updateMatrixWorld(true);
    this.colliderDebug.update();
  }

  /** Writes a motion's (pitch, yaw, roll, head lag) at bang count `b`, time `t` and look phase, scaled by `a`. */
  private pose(motion: HeadMotion, b: number, t: number, look: number, a: number, out: number[]): void {
    const phase = b - Math.floor(b);
    // Bounce curve: 1 exactly on the beat (head at the bottom), 0 half way between beats.
    const bounce = (ph: number) => 1 - Math.abs(Math.sin(Math.PI * ph));
    let pitch = 0;
    let yaw = 0;
    let roll = 0;
    let headLag = 0;
    switch (motion) {
      case 'idle':
        pitch = Math.sin(t * 0.7) * 0.05 + Math.sin(t * 1.9) * 0.02;
        yaw = Math.sin(t * 0.45) * 0.12;
        roll = Math.sin(t * 0.6 + 1) * 0.03;
        break;
      case 'nod':
        pitch = Math.pow(bounce(phase), 1.5) * 0.3 - 0.04;
        break;
      case 'headbang':
        // Head hits the bottom on the beat and snaps back up; the head lags the neck slightly (whip).
        pitch = Math.pow(bounce(phase), 1.3) * 0.66 - 0.12;
        headLag = Math.pow(bounce(phase - 0.06 - Math.floor(phase - 0.06)), 1.3) * 0.66 - 0.12 - pitch;
        roll = Math.sin(Math.PI * b) * 0.04;
        break;
      case 'roxbury': {
        // "What Is Love" head bob (A Night at the Roxbury): on every beat the head snaps into a tilt to his
        // left (negative roll; he faces +z, so his left is +x), turning slightly to his right, then swings back.
        const s = Math.pow(bounce(phase), 1.4);
        roll = -s * 0.46;
        yaw = -s * 0.12;
        pitch = s * 0.07;
        break;
      }
      case 'lookAround':
        yaw = Math.sin(look * Math.PI * 0.5) * 0.75;
        pitch = Math.sin(look * Math.PI) * 0.08;
        break;
    }
    out[0] = pitch * a;
    out[1] = yaw * a;
    out[2] = roll * a;
    out[3] = headLag * a;
  }

  dispose(): void {
    this.opts.hair.remove(this.hair);
    this.colliderDebug.dispose();
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
