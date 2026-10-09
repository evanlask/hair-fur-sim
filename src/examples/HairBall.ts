import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as THREE from 'three/webgpu';
import type { FolderApi } from 'tweakpane';

import type { FrameInfo } from '../app/App';
import { addHairBasics, addHairFolders, addWindFolder, num, toggle } from '../app/Gui';
import { DragSpring } from '../app/Interaction';
import { ColliderSet } from '../hair/colliders';
import { applyHairColor, hairColorOptions, type HairColorName } from '../hair/colorPresets';
import { createBallStyle, defaultBallStyle, type BallStyleParams } from '../hair/groom/styles/ballStyle';
import { rigidGrowth } from '../hair/growth';
import type { HairInstance } from '../hair/HairInstance';
import { mergeHairParams, type HairParamsData, type ShadingParams } from '../hair/params';
import { OPAQUE_SHADOW_LAYER, applyHairShadow } from '../hair/render/HairShadowPass';
import type { Example, ExampleContext } from './Example';

type ShapeName = 'sphere' | 'torus' | 'roundedBox' | 'capsule' | 'torusKnot';
type MotionName = 'none' | 'orbit' | 'bob' | 'shake' | 'spin' | 'swing';

const HOME = new THREE.Vector3(0, 1.0, 0);

/** THREE.TorusKnotGeometry's centre curve (same formula), so the knot's capsule chain follows the mesh. */
function knotPoint(u: number, p: number, q: number, radius: number, out: THREE.Vector3): THREE.Vector3 {
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const quOverP = (q / p) * u;
  const cs = Math.cos(quOverP);
  return out.set(
    radius * (2 + cs) * 0.5 * cu,
    radius * (2 + cs) * su * 0.5,
    radius * Math.sin(quOverP) * 0.5,
  );
}

/** Hair on basic geometry, draggable, with motion presets and wind. */
export class HairBallExample implements Example {
  readonly title = 'Hair Ball';
  private ctx!: ExampleContext;
  private pivot = new THREE.Group();
  private body!: THREE.Mesh;
  private instance: HairInstance | null = null;
  private drag!: DragSpring;
  private readonly settings = {
    shape: 'sphere' as ShapeName,
    motion: 'none' as MotionName,
    motionSpeed: 1,
    motionAmount: 1,
    showBody: true,
    showGuides: false,
    showStrands: true,
    hairColor: 'brown' as HairColorName,
  };
  private readonly groomParams: BallStyleParams = defaultBallStyle();
  private hairParams: HairParamsData = mergeHairParams({
    physics: { globalStiffness: 0.04, localStiffness: 0.55, damping: 1.2 },
    style: { rootWidth: 0.0003, tipWidth: 0.00008 },
    shading: { rootColor: '#3a2113', tipColor: '#9a6a3f' },
  });
  private readonly shadingDefaults: ShadingParams = { ...this.hairParams.shading };
  private rebuildTimer = 0;
  private time = 0;

  async init(ctx: ExampleContext): Promise<void> {
    this.ctx = ctx;
    const { app, gui, lights } = ctx;
    this.pivot.position.copy(HOME);
    app.scene.add(this.pivot);
    app.camera.position.set(0.15, 1.15, 1.55);
    app.controls.target.copy(HOME);
    lights.focus.copy(HOME);
    lights.focusRadius = 0.9;
    lights.update();
    this.hairParams.physics.substeps = ctx.quality.substeps;

    this.drag = new DragSpring(app, this.pivot, () => (this.body ? [this.body] : []));
    this.drag.home.copy(HOME);
    this.buildBody();
    this.buildHair();

    const f = gui.folder('Hair Ball', true);
    f.addBinding(this.settings, 'shape', {
      options: {
        sphere: 'sphere',
        torus: 'torus',
        'rounded box': 'roundedBox',
        capsule: 'capsule',
        'torus knot': 'torusKnot',
      },
    }).on('change', () => {
      this.buildBody();
      this.buildHair();
    });
    f.addBinding(this.settings, 'motion', {
      options: {
        'drag only': 'none',
        orbit: 'orbit',
        bob: 'bob',
        shake: 'shake',
        spin: 'spin',
        swing: 'swing',
      },
    });
    num(f, this.settings, 'motionSpeed', { min: 0.1, max: 3, label: 'speed' }, () => {});
    num(f, this.settings, 'motionAmount', { min: 0, max: 2, label: 'amount' }, () => {});

    const hairFolder = gui.folder('Hair', true);
    const sync = () => this.syncParams();
    hairFolder
      .addBinding(this.settings, 'hairColor', { label: 'hair color', options: hairColorOptions() })
      .on('change', () => {
        applyHairColor(this.hairParams.shading, this.shadingDefaults, this.settings.hairColor);
        this.syncParams();
        gui.pane.refresh();
      });
    addHairBasics(hairFolder, this.hairParams, sync);
    const groom = gui.folder('Groom (regrows hair)', false, hairFolder);
    const rebuild = () => this.scheduleRebuild();
    num(groom, this.groomParams, 'length', { min: 2, max: 50, scale: 100, label: 'length (cm)' }, rebuild);
    num(
      groom,
      this.groomParams,
      'lengthJitter',
      {
        min: 0,
        max: 0.8,
        label: 'length jitter',
        hint: 'Random length difference between guide hairs (±).',
      },
      rebuild,
    );
    num(
      groom,
      this.groomParams,
      'lengthVariation',
      {
        min: 0,
        max: 0.9,
        label: 'length variation',
        hint: 'Random shortening of individual strands.',
      },
      rebuild,
    );
    num(
      groom,
      this.groomParams,
      'lift',
      { min: 0, max: 1, hint: '1 = hair grows straight out, 0 = combed flat along the surface.' },
      rebuild,
    );
    num(
      groom,
      this.groomParams,
      'droop',
      { min: 0, max: 40, hint: 'How quickly strands bend down towards gravity.' },
      rebuild,
    );
    num(groom, this.groomParams, 'wave', { min: 0, max: 30, scale: 1000, label: 'wave size (mm)' }, rebuild);
    num(groom, this.groomParams, 'waveCount', { min: 0, max: 8, label: 'wave count' }, rebuild);
    num(
      groom,
      this.groomParams,
      'guideCount',
      { min: 100, max: 8000, step: 50, label: 'guide count', hint: 'Simulated guide hairs.' },
      rebuild,
    );
    num(
      groom,
      this.groomParams,
      'strandCount',
      {
        min: 1000,
        max: 400000,
        step: 1000,
        label: 'strand count',
        hint: 'Drawn strands (interpolated from the guides).',
      },
      rebuild,
    );
    num(
      groom,
      this.groomParams,
      'guideParticles',
      {
        min: 4,
        max: 32,
        step: 1,
        label: 'points per guide',
        hint: 'Simulated points along each guide: more bends more smoothly but costs speed.',
      },
      rebuild,
    );
    num(
      groom,
      this.groomParams,
      'strandPoints',
      {
        min: 4,
        max: 48,
        step: 1,
        label: 'points per strand',
        hint: 'Drawn points along each strand: more gives smoother curls.',
      },
      rebuild,
    );

    addWindFolder(hairFolder);
    addHairFolders(hairFolder, this.hairParams, sync);
  }

  viewControls(f: FolderApi): void {
    toggle(f, this.settings, 'showBody', () => (this.body.visible = this.settings.showBody), 'show body');
    toggle(f, this.settings, 'showStrands', () => this.applyVisibility(), 'show hair');
    toggle(
      f,
      this.settings,
      'showGuides',
      () => this.applyVisibility(),
      'show guides',
      'Show the simulated guide hairs the drawn strands follow.',
    );
  }

  /** Pushes GUI parameter changes to the GPU; the body is tinted like the hair roots. */
  private syncParams(): void {
    this.instance?.groups.forEach((g) => g.syncParams());
    (this.body.material as THREE.MeshPhysicalNodeMaterial).color
      .set(this.hairParams.shading.rootColor)
      .multiplyScalar(0.7);
  }

  private applyVisibility(): void {
    this.instance?.setVisibility(this.settings.showStrands, this.settings.showGuides);
  }

  private scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.regroom(), 250);
  }

  private makeGeometry(shape: ShapeName): THREE.BufferGeometry {
    switch (shape) {
      case 'torus':
        return new THREE.TorusGeometry(0.2, 0.085, 48, 128);
      case 'roundedBox':
        return new RoundedBoxGeometry(0.36, 0.36, 0.36, 6, 0.06);
      case 'capsule':
        return new THREE.CapsuleGeometry(0.13, 0.26, 16, 48);
      case 'torusKnot':
        return new THREE.TorusKnotGeometry(0.17, 0.05, 320, 32);
      default:
        return new THREE.SphereGeometry(0.22, 96, 64);
    }
  }

  private buildBody(): void {
    if (this.body) {
      this.pivot.remove(this.body);
      this.body.geometry.dispose();
      (this.body.material as THREE.Material).dispose();
    }
    const geometry = this.makeGeometry(this.settings.shape);
    const material = new THREE.MeshPhysicalNodeMaterial({
      color: new THREE.Color(this.hairParams.shading.rootColor).multiplyScalar(0.7),
      roughness: 1,
      specularIntensity: 0.2,
      envMapIntensity: 0.15,
    });
    this.body = new THREE.Mesh(geometry, material);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.body.layers.enable(OPAQUE_SHADOW_LAYER);
    this.body.visible = this.settings.showBody;
    // Lay the torus shapes flat (three.js builds them in the XY plane).
    if (this.settings.shape === 'torus' || this.settings.shape === 'torusKnot')
      this.body.rotation.x = Math.PI / 2;
    this.pivot.add(this.body);
    this.pivot.updateMatrixWorld(true);
  }

  private makeColliders(): ColliderSet {
    const c = new ColliderSet();
    const b = this.body;
    switch (this.settings.shape) {
      case 'torus':
        c.setShape('torus', new THREE.Vector4(0.2, 0.085, 0, 0), b);
        break;
      case 'roundedBox':
        c.setShape('box', new THREE.Vector4(0.18, 0.18, 0.18, 0.06), b);
        break;
      case 'capsule':
        c.add({
          name: 'capsule',
          a: new THREE.Vector3(0, -0.13, 0),
          b: new THREE.Vector3(0, 0.13, 0),
          radius: 0.13,
          attach: b,
        });
        break;
      case 'torusKnot': {
        const n = 40;
        const pa = new THREE.Vector3();
        const pb = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          knotPoint((i / n) * Math.PI * 4, 2, 3, 0.17, pa);
          knotPoint(((i + 1) / n) * Math.PI * 4, 2, 3, 0.17, pb);
          c.add({ name: `knot${i}`, a: pa.clone(), b: pb.clone(), radius: 0.05, attach: b });
        }
        break;
      }
      default:
        c.setShape('sphere', new THREE.Vector4(0.22, 0, 0, 0), b);
    }
    return c;
  }

  private buildHair(): void {
    const { hair, quality } = this.ctx;
    if (this.instance) hair.remove(this.instance);
    // Groom in the pivot's home pose so rest data is stable.
    const savedPos = this.pivot.position.clone();
    const savedQuat = this.pivot.quaternion.clone();
    this.pivot.position.copy(HOME);
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld(true);
    const { source, growth } = rigidGrowth(this.body.geometry, this.body);
    this.instance = hair.createInstance({
      name: 'ball',
      source,
      growth,
      style: createBallStyle(this.groomParams),
      colliders: this.makeColliders(),
      paramObjects: { hair: this.hairParams },
      groom: {
        seed: 7,
        strandScale: quality.strandScale,
        guideScale: quality.guideScale,
        collisionMargin: 0.004,
      },
      boundsObject: this.body,
    });
    this.instance.setVisibility(this.settings.showStrands, this.settings.showGuides);
    applyHairShadow(
      this.body.material as THREE.NodeMaterial,
      this.instance.shadowMap,
      this.instance.bodyShadowDensity,
    );
    this.pivot.position.copy(savedPos);
    this.pivot.quaternion.copy(savedQuat);
    this.pivot.updateMatrixWorld(true);
  }

  /** Re-grooms with the current groom params (keeps the instance and its shadow map). */
  private regroom(): void {
    if (!this.instance) return this.buildHair();
    const savedPos = this.pivot.position.clone();
    const savedQuat = this.pivot.quaternion.clone();
    this.pivot.position.copy(HOME);
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld(true);
    this.instance.setStyle(createBallStyle(this.groomParams));
    this.instance.build();
    this.pivot.position.copy(savedPos);
    this.pivot.quaternion.copy(savedQuat);
    this.pivot.updateMatrixWorld(true);
  }

  update(info: FrameInfo): void {
    const s = this.settings;
    this.time += info.dt * s.motionSpeed;
    const t = this.time;
    const a = s.motionAmount;
    const home = this.drag.home.copy(HOME);
    const q = new THREE.Quaternion();
    switch (s.motion) {
      case 'orbit':
        home.x += Math.cos(t * 1.6) * 0.35 * a;
        home.z += Math.sin(t * 1.6) * 0.35 * a;
        break;
      case 'bob':
        home.y += Math.sin(t * 3.2) * 0.12 * a;
        break;
      case 'shake':
        home.x += Math.sin(t * 14) * 0.05 * a;
        break;
      case 'spin':
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 2.5 * a);
        break;
      case 'swing':
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(t * 2.2) * 0.9 * a);
        break;
    }
    this.pivot.quaternion.copy(q);
    this.drag.update(info.dt);
    this.pivot.updateMatrixWorld(true);
  }

  hud(): string[] {
    return [`shape ${this.settings.shape}   motion ${this.settings.motion}`];
  }
}
