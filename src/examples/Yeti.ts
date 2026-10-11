import type { FolderApi } from 'tweakpane';

import type { FrameInfo } from '../app/App';
import { addHairBasics, addHairFolders, addWindFolder, num, toggle } from '../app/Gui';
import { DragSpring } from '../app/Interaction';
import { applyHairColor, hairColorOptions, type HairColorName } from '../hair/colorPresets';
import { mergeHairParams, type HairParamsData, type ShadingParams } from '../hair/params';
import type { Example, ExampleContext } from './Example';
import {
  YetiCharacter,
  defaultYetiGroom,
  loadYeti,
  type YetiGroomParams,
  type YetiMotion,
} from './YetiCharacter';

/** Shaggy, slightly clumpy monster fur coloured from the yeti's texture (pale frost blue). */
export function createYetiFurParams(substeps: number): HairParamsData {
  return mergeHairParams({
    physics: {
      substeps,
      globalStiffness: 0.28,
      globalTip: 0.2,
      globalCurve: 1,
      localStiffness: 0.65,
      localTip: 0.4,
      damping: 3,
      drag: 2.2,
      followRoot: 0.2,
      rootPlane: 0.4,
      rootPlaneRange: 1,
      collisionMargin: 0.003,
      collisionFriction: 0.35,
      rootColliderRange: 1,
      // Where skin folds onto fur (armpits, an arm against the belly) the fur near the root passes under the
      // fold instead of being shoved out of it and flipping.
      sdfRootRange: 0.3,
      maxVelocity: 10,
    },
    style: {
      rootWidth: 0.0012,
      tipWidth: 0.0002,
      taper: 1.2,
      // Render strands collide too, so limbs push the fur aside during the animation instead of swallowing it.
      collide: true,
      clump: 0.22,
      clumpShape: 1.4,
      frizz: 0.0014,
      frizzFrequency: 3,
      // A loose wave along the long strands so the coat doesn't hang dead straight.
      curlRadius: 0.0025,
      curlTurns: 1.5,
      curlRamp: 0.4,
      lodStrandsPerPixel: 6,
      // Long fur on the limbs shows well past the silhouette: only skip fur facing nearly straight away.
      backCull: 0.75,
    },
    shading: {
      rootColor: '#b3c3cf',
      tipColor: '#ffffff',
      gradientStart: 0,
      gradientEnd: 1,
      // Partly from the texture (blue-grey shading) without its painted patches.
      textureInfluence: 0.55,
      hueJitter: 0.02,
      valueJitter: 0.1,
      specular: 0.35,
      roughness: 0.5,
      backlit: 0.9,
      scatter: 1,
      selfShadowDensity: 200,
      aoRoot: 0.35,
      aoRange: 0.4,
      tipFade: 0.25,
    },
  });
}

/** A furry cartoon yeti (Babylon.js Yeti, CC BY 4.0) with simulated strand fur. */
export class YetiExample implements Example {
  readonly title = 'Yeti';
  private character!: YetiCharacter;
  private drag!: DragSpring;
  private params!: HairParamsData;
  private shadingDefaults!: ShadingParams;
  private readonly groom: YetiGroomParams = defaultYetiGroom();
  private readonly settings = {
    motion: 'idle' as YetiMotion,
    speed: 1,
    furColor: 'brown' as HairColorName,
    showBody: true,
    showFur: true,
    showGuides: false,
    showColliders: false,
  };
  private rebuildTimer = 0;

  async init(ctx: ExampleContext): Promise<void> {
    const { app, gui, hair, lights, quality } = ctx;
    this.params = createYetiFurParams(quality.substeps);
    this.shadingDefaults = { ...this.params.shading };
    await ctx.loading.step('Loading yeti model…');
    await loadYeti();
    await ctx.loading.step('Growing fur…');
    this.character = await YetiCharacter.create({
      name: 'yeti',
      hair,
      params: this.params,
      groom: this.groom,
      strandScale: quality.strandScale,
      guideScale: quality.guideScale,
    });
    app.scene.add(this.character.root, this.character.colliderDebug.group);
    // Grab and shake the yeti; it springs back.
    this.drag = new DragSpring(app, this.character.root, () => [this.character.mesh]);
    this.drag.stiffness = 140;
    this.drag.damping = 14;

    app.camera.position.set(1.45, 1.2, 2.1);
    app.controls.target.set(0, 0.72, 0);
    lights.focus.set(0, 0.8, 0);
    lights.focusRadius = 1.3;
    lights.update();

    const f = gui.folder('Yeti');
    f.addBinding(this.settings, 'motion', { options: { idle: 'idle', still: 'still' } }).on(
      'change',
      () => (this.character.motion = this.settings.motion),
    );
    num(
      f,
      this.settings,
      'speed',
      { min: 0.1, max: 2, label: 'speed' },
      () => (this.character.speed = this.settings.speed),
    );

    const sync = () => {
      for (const g of this.character.hair.groups) g.syncParams();
      this.character.furTint.value.set(this.params.shading.rootColor);
    };
    const fur = gui.folder('Fur');
    // The 'brown' preset restores this example's defaults, which for the yeti is its own frost look.
    const furOptions = Object.fromEntries(
      Object.entries(hairColorOptions()).map(([label, value]) => [
        value === 'brown' ? 'frost' : label,
        value,
      ]),
    );
    fur
      .addBinding(this.settings, 'furColor', { label: 'fur color', options: furOptions })
      .on('change', () => {
        applyHairColor(this.params.shading, this.shadingDefaults, this.settings.furColor);
        sync();
        gui.pane.refresh();
      });
    addHairBasics(fur, this.params, sync);
    const g = gui.folder('Groom (regrows fur)', false, fur);
    const rebuild = () => this.scheduleRegroom();
    num(g, this.groom, 'lengthScale', { min: 0.3, max: 3, label: 'length scale' }, rebuild);
    num(g, this.groom, 'beardLength', { min: 2, max: 20, scale: 100, label: 'beard length (cm)' }, rebuild);
    num(
      g,
      this.groom,
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
      g,
      this.groom,
      'spots',
      { min: 0, max: 1, label: 'spots', hint: 'Amount of the violet spot pattern.' },
      rebuild,
    );
    num(
      g,
      this.groom,
      'guideCount',
      { min: 100, max: 8000, step: 50, label: 'guide count', hint: 'Simulated guide hairs.' },
      rebuild,
    );
    num(g, this.groom, 'strandCount', { min: 5000, max: 500000, step: 5000, label: 'strand count' }, rebuild);
    num(
      g,
      this.groom,
      'guideParticles',
      {
        min: 4,
        max: 16,
        step: 1,
        label: 'points per guide',
        hint: 'Simulated points along each guide: more bends more smoothly but costs speed.',
      },
      rebuild,
    );
    num(
      g,
      this.groom,
      'strandPoints',
      {
        min: 4,
        max: 16,
        step: 1,
        label: 'points per strand',
        hint: 'Drawn points along each strand: more gives smoother curls.',
      },
      rebuild,
    );
    addWindFolder(gui.pane);
    addHairFolders(fur, this.params, sync);
    sync();
  }

  viewControls(f: FolderApi): void {
    toggle(
      f,
      this.settings,
      'showBody',
      () => (this.character.mesh.visible = this.settings.showBody),
      'show body',
    );
    toggle(f, this.settings, 'showFur', () => this.applyVisibility(), 'show fur');
    toggle(
      f,
      this.settings,
      'showGuides',
      () => this.applyVisibility(),
      'show guides',
      'Show the simulated guide hairs the drawn strands follow.',
    );
    toggle(
      f,
      this.settings,
      'showColliders',
      () => (this.character.colliderDebug.group.visible = this.settings.showColliders),
      'show colliders',
      'Show the shapes the fur collides with.',
    );
  }

  private applyVisibility(): void {
    this.character.hair.setVisibility(this.settings.showFur, this.settings.showGuides);
  }

  private scheduleRegroom(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.character.regroom(), 300);
  }

  update(info: FrameInfo): void {
    this.drag.update(info.dt);
    this.character.update(info.dt);
    this.character.colliderDebug.update();
  }

  hud(): string[] {
    return [`yeti   ${this.settings.motion}`];
  }
}
