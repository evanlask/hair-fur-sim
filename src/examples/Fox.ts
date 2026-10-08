import type { FrameInfo } from '../app/App';
import { addHairParamFolders, addSimulationControls, num, toggle } from '../app/Gui';
import { mergeHairParams, type HairParamsData } from '../hair/params';
import type { Example, ExampleContext } from './Example';
import {
  FoxCharacter,
  defaultFoxGroom,
  loadFox,
  type FoxAnimation,
  type FoxGroomParams,
} from './FoxCharacter';

/** Default fur tuning (shared by every fox so the GUI drives all of them). */
export function createFoxFurParams(substeps: number): HairParamsData {
  return mergeHairParams({
    physics: {
      substeps,
      globalStiffness: 0.3,
      globalTip: 0.3,
      globalCurve: 1,
      localStiffness: 0.75,
      localTip: 0.6,
      damping: 4,
      drag: 3,
      followRoot: 0.35,
      rootPlane: 0.45,
      rootPlaneRange: 1,
      collisionMargin: 0.002,
      collisionFriction: 0.4,
      rootColliderRange: 1,
      maxVelocity: 8,
    },
    // Fine, dense and only lightly clumped near the tips: fox fur lies smooth and plush.
    style: {
      rootWidth: 0.00035,
      tipWidth: 0.00007,
      taper: 1.2,
      clump: 0.12,
      clumpShape: 2,
      frizz: 0.001,
      frizzFrequency: 5,
      lodStrandsPerPixel: 6,
    },
    shading: {
      rootColor: '#c7bcb3',
      tipColor: '#ffffff',
      gradientStart: 0,
      gradientEnd: 0.9,
      textureInfluence: 1,
      hueJitter: 0.04,
      valueJitter: 0.12,
      specular: 0.4,
      roughness: 0.45,
      backlit: 0.7,
      scatter: 0.8,
      selfShadowDensity: 320,
      aoRoot: 0.25,
      aoRange: 0.5,
      tipFade: 0.3,
    },
  });
}

/** Fur on the animated Khronos Fox (CC0 model, CC BY 4.0 rig and animation). */
export class FoxExample implements Example {
  readonly title = 'Fox';
  private ctx!: ExampleContext;
  private foxes: FoxCharacter[] = [];
  private params!: HairParamsData;
  private readonly groom: FoxGroomParams = defaultFoxGroom();
  private readonly settings = {
    animation: 'Walk' as FoxAnimation,
    moving: true,
    speed: 1,
    pathRadius: 1.3,
    twoFoxes: false,
    showBody: true,
    showStrands: true,
    showGuides: false,
    showColliders: false,
    paused: false,
  };
  private rebuildTimer = 0;

  async init(ctx: ExampleContext): Promise<void> {
    this.ctx = ctx;
    const { app, gui, lights, quality } = ctx;
    this.params = createFoxFurParams(quality.substeps);
    app.camera.position.set(2.6, 1.5, 2.9);
    app.controls.target.set(0, 0.35, 0);
    lights.focus.set(0, 0.4, 0);
    lights.focusRadius = 2.2;
    lights.update();
    await loadFox();
    await this.spawn();

    const f = gui.folder('Fox', true);
    f.addBinding(this.settings, 'animation', { options: { survey: 'Survey', walk: 'Walk', run: 'Run' } }).on(
      'change',
      () => this.foxes.forEach((fx) => fx.setAnimation(this.settings.animation)),
    );
    num(f, this.settings, 'speed', { min: 0.1, max: 2, label: 'speed' }, () =>
      this.foxes.forEach((fx) => (fx.speedScale = this.settings.speed)),
    );
    toggle(
      f,
      this.settings,
      'moving',
      () => this.foxes.forEach((fx) => (fx.moving = this.settings.moving)),
      'follow path',
    );
    num(f, this.settings, 'pathRadius', { min: 0.6, max: 3, label: 'path radius' }, () =>
      this.foxes.forEach((fx) => (fx.pathRadius = this.settings.pathRadius)),
    );
    toggle(f, this.settings, 'twoFoxes', () => this.spawn(), 'two foxes');

    const fur = gui.folder('Fur', false);
    const g = gui.folder('Groom (regrows fur)', false, fur);
    const rebuild = () => this.scheduleRegroom();
    num(g, this.groom, 'lengthScale', { min: 0.3, max: 3, label: 'length scale' }, rebuild);
    num(g, this.groom, 'tailLength', { min: 0.01, max: 0.2, label: 'tail length' }, rebuild);
    num(g, this.groom, 'ruffLength', { min: 0.01, max: 0.12, label: 'ruff length' }, rebuild);
    num(g, this.groom, 'lengthVariation', { min: 0, max: 0.9, label: 'strand length var.' }, rebuild);
    num(g, this.groom, 'guideCount', { min: 200, max: 8000, step: 50, label: 'guides' }, rebuild);
    num(g, this.groom, 'strandCount', { min: 5000, max: 500000, step: 5000, label: 'strands' }, rebuild);
    num(g, this.groom, 'guideParticles', { min: 4, max: 16, step: 1, label: 'guide particles' }, rebuild);
    num(g, this.groom, 'strandPoints', { min: 4, max: 16, step: 1, label: 'strand points' }, rebuild);

    addHairParamFolders(fur, this.params, () => this.syncAll());

    const debug = gui.folder('Debug', false);
    toggle(
      debug,
      this.settings,
      'showBody',
      () => this.foxes.forEach((fx) => (fx.mesh.visible = this.settings.showBody)),
      'show body',
    );
    toggle(debug, this.settings, 'showStrands', () => this.applyVisibility(), 'show fur');
    toggle(debug, this.settings, 'showGuides', () => this.applyVisibility(), 'show guides');
    toggle(
      debug,
      this.settings,
      'showColliders',
      () => this.foxes.forEach((fx) => (fx.colliderDebug.group.visible = this.settings.showColliders)),
      'show colliders',
    );
    addSimulationControls(debug, ctx.hair, this.settings);
  }

  private syncAll(): void {
    for (const fx of this.foxes) for (const g of fx.hair.groups) g.syncParams();
  }

  private applyVisibility(): void {
    for (const fx of this.foxes) fx.hair.setVisibility(this.settings.showStrands, this.settings.showGuides);
  }

  private scheduleRegroom(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.foxes.forEach((fx) => fx.regroom()), 300);
  }

  private async spawn(): Promise<void> {
    for (const fx of this.foxes) fx.dispose();
    this.foxes = [];
    const { app, hair, quality } = this.ctx;
    const count = this.settings.twoFoxes ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const fox = await FoxCharacter.create({
        name: `fox${i}`,
        hair,
        params: this.params,
        groom: this.groom,
        strandScale: quality.strandScale,
        guideScale: quality.guideScale,
        seed: 3 + i,
      });
      fox.pathRadius = this.settings.pathRadius;
      fox.pathAngle = i * Math.PI;
      fox.speedScale = this.settings.speed;
      fox.moving = this.settings.moving;
      fox.setAnimation(this.settings.animation, 0);
      fox.mesh.visible = this.settings.showBody;
      fox.colliderDebug.group.visible = this.settings.showColliders;
      app.scene.add(fox.root, fox.colliderDebug.group);
      this.foxes.push(fox);
    }
    this.applyVisibility();
    hair.resetAll();
  }

  update(info: FrameInfo): void {
    for (const fx of this.foxes) fx.update(info.dt);
  }

  hud(): string[] {
    return [
      `foxes ${this.foxes.length}   ${this.settings.animation}${this.settings.moving ? ' (moving)' : ''}`,
    ];
  }
}
