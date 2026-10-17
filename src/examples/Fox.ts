import type { FolderApi } from 'tweakpane';

import type { FrameInfo } from '../app/App';
import { addHairBasics, addHairFolders, addWindFolder, alphabetical, num, toggle } from '../app/Gui';
import type { QualityPreset } from '../app/quality';
import { defaultGrassStyle } from '../hair/groom/styles/grassStyle';
import { hairWind, mergeHairParams, type HairParamsData } from '../hair/params';
import type { Example, ExampleContext } from './Example';
import {
  FoxCharacter,
  defaultFoxGroom,
  loadFox,
  type FoxAnimation,
  type FoxGroomParams,
} from './FoxCharacter';
import { FoxPath, MAX_WOBBLE } from './FoxPath';
import { GRASS_PANEL, GrassField, createGrassParams, type GrassParams } from './Grass';

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
      // Short fur barely shows past the silhouette, so fur facing well away from the camera is skipped.
      backCull: 0.5,
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

/** Phones and tablets (iPadOS reports itself as a Mac, but with touch). */
const IS_MOBILE =
  /iPhone|iPad|iPod|Android/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * At the default quality a phone runs out of memory on the full field and two foxes (over 1 GB with three.js's CPU
 * copies) and the tab is killed, so unless `?quality=` asks otherwise it grows a quarter of the strands, like 'low'.
 */
function foxQuality(quality: QualityPreset): { quality: QualityPreset; reduced: boolean } {
  if (!IS_MOBILE || new URLSearchParams(location.search).has('quality')) return { quality, reduced: false };
  const strandScale = Math.min(quality.strandScale, 0.25);
  const guideScale = Math.min(quality.guideScale, 0.6);
  const reduced = strandScale < quality.strandScale || guideScale < quality.guideScale;
  return { quality: { ...quality, strandScale, guideScale }, reduced };
}

/** Fur on the animated Khronos Fox (CC0 model, CC BY 4.0 rig and animation). */
export class FoxExample implements Example {
  readonly title = 'Fox';
  private ctx!: ExampleContext;
  private foxes: FoxCharacter[] = [];
  private params!: HairParamsData;
  private readonly groom: FoxGroomParams = defaultFoxGroom();
  private grass: GrassField | null = null;
  private grassParams!: GrassParams;
  /** A fresh seed per load, so the tufts, bare patches and stalk drifts land somewhere new each time. */
  private readonly grassStyle = { ...defaultGrassStyle(), seed: (Math.random() * 2 ** 31) | 0 };
  /** One loop for every fox: they walk it at opposite angles, so they never meet. */
  private readonly path = new FoxPath(5);
  private readonly settings = {
    animation: 'Walk' as FoxAnimation,
    moving: true,
    speed: 1,
    pathRadius: 2.2,
    pathWiggle: 1,
    twoFoxes: true,
    showBody: true,
    showStrands: true,
    showGuides: false,
    showColliders: false,
    grass: true,
    pushRadius: 1,
    showGrass: true,
    showGrassGuides: false,
  };
  private rebuildTimer = 0;
  private grassTimer = 0;
  /** The spawn in progress, and whether settings changed during it (spawns must not overlap). */
  private spawning: Promise<void> | null = null;
  private respawnPending = false;
  /** Fewer strands than the quality preset asks for (phones, see foxQuality). */
  private reduced = false;

  async init(baseCtx: ExampleContext): Promise<void> {
    const { quality: scaled, reduced } = foxQuality(baseCtx.quality);
    const ctx = (this.ctx = { ...baseCtx, quality: scaled });
    this.reduced = reduced;
    const { app, gui, lights, quality } = ctx;
    this.params = createFoxFurParams(quality.substeps);
    this.grassParams = createGrassParams(quality.substeps, quality.strandScale);
    app.camera.position.set(3.6, 2, 4);
    app.controls.target.set(0, 0.35, 0);
    lights.focus.set(0, 0.4, 0);
    lights.focusRadius = 3.2;
    lights.update();
    // A light crosswind (across the default view), so gusts roll across the grass.
    Object.assign(hairWind.params, {
      enabled: true,
      strength: 1.8,
      azimuth: -48,
      elevation: 5,
      turbulence: 0.45,
      frequency: 0.6,
      gust: 0.7,
      gustPeriod: 6,
    });
    hairWind.sync();
    await ctx.loading.step('Loading fox model…');
    await loadFox();
    await ctx.loading.step('Growing fur…');
    await this.respawn();
    await ctx.loading.step('Growing grass…');
    this.setGrass(this.settings.grass);

    const f = gui.folder('Fox');
    f.addBinding(this.settings, 'animation', {
      label: 'motion',
      options: alphabetical({ survey: 'Survey', walk: 'Walk', run: 'Run' }),
    }).on('change', () => this.foxes.forEach((fx) => fx.setAnimation(this.settings.animation)));
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
    num(f, this.settings, 'pathRadius', { min: 0.6, max: 4, label: 'path radius (m)' }, () => {
      this.path.radius = this.settings.pathRadius;
    });
    num(
      f,
      this.settings,
      'pathWiggle',
      {
        min: 0,
        max: 1.5,
        label: 'path wiggle',
        hint: `How much the loop wanders in and out (0 = a circle; at most ±${Math.round(MAX_WOBBLE * 150)}% of the radius). Two foxes start on opposite sides and drift closer and apart, sometimes one right behind the other, but never touch.`,
      },
      () => {
        this.path.wiggle = this.settings.pathWiggle;
      },
    );
    f.addButton({ title: 'New path' }).on('click', () => this.path.reseed((Math.random() * 2 ** 31) | 0));
    toggle(f, this.settings, 'twoFoxes', () => void this.respawn(), 'two foxes');

    const grass = gui.folder('Grass');
    toggle(
      grass,
      this.settings,
      'grass',
      () => {
        // Growing takes seconds; removing is instant. Reads the setting when it runs, in case it flipped back.
        const apply = () => this.setGrass(this.settings.grass);
        if (this.settings.grass) void this.ctx.loading.busy('Growing grass…', apply);
        else apply();
      },
      'grass',
      'Prairie grass on the ground, simulated like hair.',
    );
    const regrow = () => this.scheduleGrassRegroom();
    num(
      grass,
      this.grassStyle,
      'height',
      { min: 0.3, max: 2, digits: 2, label: 'grass height', hint: 'Length of the short grass (regrows it).' },
      regrow,
    );
    num(
      grass,
      this.grassStyle,
      'stalkHeight',
      {
        min: 0.3,
        max: 2,
        digits: 2,
        label: 'stalk height',
        hint: 'Length of the tall seed stalks (regrows the grass).',
      },
      regrow,
    );
    num(
      grass,
      this.grassStyle,
      'stalkAmount',
      {
        min: 0,
        max: 3,
        label: 'stalk amount',
        hint: 'How much of the field the seed stalks cover (regrows the grass).',
      },
      regrow,
    );
    grass.addButton({ title: 'New field' }).on('click', () => {
      this.grassStyle.seed = (Math.random() * 2 ** 31) | 0;
      this.scheduleGrassRegroom();
    });
    num(
      grass,
      this.settings,
      'pushRadius',
      {
        min: 0,
        max: 2,
        label: 'fox push radius',
        hint: 'Size of the shapes the foxes push the grass aside with.',
      },
      () => {
        if (this.grass) this.grass.colliders.radiusScale = this.settings.pushRadius;
      },
    );
    const perf = { cull: true, lodDistance: 3 };
    const syncLod = () => {
      for (const k of ['grass', 'stalks'] as const) {
        const st = this.grassParams[k].style;
        st.cullOffscreen = perf.cull;
        // Stalks are sparse, so they keep a longer reach than the grass.
        st.lodDistance = perf.lodDistance > 0 ? perf.lodDistance * (k === 'stalks' ? 4 / 3 : 1) : 0;
      }
      this.grass?.syncParams();
    };
    toggle(
      grass,
      perf,
      'cull',
      syncLod,
      'skip off-screen blades',
      'Faster: blades outside the view (with a margin for their shadows) are not simulated into strands, lit or drawn.',
    );
    num(
      grass,
      perf,
      'lodDistance',
      {
        min: 0,
        max: 20,
        label: 'thin beyond (m)',
        hint: 'Faster: beyond this distance from the camera, blades thin out (the rest get wider, so the ground stays covered). 0 = off.',
      },
      syncLod,
    );
    // Both layers feel the same wind (the Wind folder) with their own tuning.
    const tabs = grass.addTab({ pages: [{ title: 'Grass' }, { title: 'Stalks' }] });
    const syncGrass = () => this.grass?.syncParams();
    (['grass', 'stalks'] as const).forEach((k, i) => {
      addHairBasics(tabs.pages[i], this.grassParams[k], syncGrass, GRASS_PANEL);
      addHairFolders(tabs.pages[i], this.grassParams[k], syncGrass, GRASS_PANEL);
    });

    const fur = gui.folder('Fur');
    const sync = () => this.syncAll();
    addHairBasics(fur, this.params, sync);
    const g = gui.folder('Groom (regrows fur)', false, fur);
    const rebuild = () => this.scheduleRegroom();
    num(g, this.groom, 'lengthScale', { min: 0.3, max: 3, label: 'length scale' }, rebuild);
    num(g, this.groom, 'tailLength', { min: 1, max: 20, scale: 100, label: 'tail length (cm)' }, rebuild);
    num(g, this.groom, 'ruffLength', { min: 1, max: 12, scale: 100, label: 'ruff length (cm)' }, rebuild);
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

    addHairFolders(fur, this.params, sync);

    // The wind moves both the fur and the grass.
    addWindFolder(gui.pane);
  }

  viewControls(f: FolderApi): void {
    toggle(
      f,
      this.settings,
      'showBody',
      () => this.foxes.forEach((fx) => (fx.mesh.visible = this.settings.showBody)),
      'show body',
    );
    toggle(f, this.settings, 'showStrands', () => this.applyVisibility(), 'show fur');
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
      () => this.foxes.forEach((fx) => (fx.colliderDebug.group.visible = this.settings.showColliders)),
      'show colliders',
      'Show the shapes the fur collides with.',
    );
    toggle(f, this.settings, 'showGrass', () => this.applyGrassVisibility(), 'show grass');
    toggle(
      f,
      this.settings,
      'showGrassGuides',
      () => this.applyGrassVisibility(),
      'show grass guides',
      'Show the simulated guide blades the drawn grass follows.',
    );
  }

  private setGrass(on: boolean): void {
    if (on && !this.grass) {
      this.grass = new GrassField(this.ctx, this.grassStyle, this.grassParams);
      this.grass.colliders.radiusScale = this.settings.pushRadius;
      this.grass.attachFoxes(this.foxes);
      this.applyGrassVisibility();
    } else if (!on && this.grass) {
      this.grass.dispose();
      this.grass = null;
    }
  }

  private applyGrassVisibility(): void {
    this.grass?.instance.setVisibility(this.settings.showGrass, this.settings.showGrassGuides);
  }

  private scheduleGrassRegroom(): void {
    clearTimeout(this.grassTimer);
    this.grassTimer = window.setTimeout(() => {
      const grass = this.grass;
      if (grass) void this.ctx.loading.busy('Regrowing grass…', () => grass.regroom());
    }, 300);
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

  /** Respawns the foxes, coalescing toggles that arrive while a spawn is still loading. */
  private async respawn(): Promise<void> {
    if (this.spawning) {
      this.respawnPending = true;
      return this.spawning;
    }
    this.spawning = (async () => {
      try {
        do {
          this.respawnPending = false;
          await this.spawn();
        } while (this.respawnPending);
      } finally {
        this.spawning = null;
      }
    })();
    return this.spawning;
  }

  private async spawn(): Promise<void> {
    // Drop the grass's copies of the old foxes' colliders before their bones go away.
    this.grass?.attachFoxes([]);
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
      fox.path = this.path;
      fox.pathIndex = i;
      fox.speedScale = this.settings.speed;
      fox.moving = this.settings.moving;
      fox.setAnimation(this.settings.animation, 0);
      fox.mesh.visible = this.settings.showBody;
      fox.colliderDebug.group.visible = this.settings.showColliders;
      app.scene.add(fox.root, fox.colliderDebug.group);
      this.foxes.push(fox);
    }
    this.applyVisibility();
    this.grass?.attachFoxes(this.foxes);
    hair.resetAll();
  }

  update(info: FrameInfo): void {
    this.path.advance(info.dt, this.foxes[0]?.speed ?? 0, this.foxes.length);
    for (const fx of this.foxes) fx.update(info.dt);
  }

  hud(): string[] {
    const lines = [
      `foxes ${this.foxes.length}   ${this.settings.animation}${this.settings.moving ? ' (moving)' : ''}`,
    ];
    if (this.grass) lines.push(this.grass.hud());
    if (this.reduced) lines.push('phone: ¼ of the strands (add ?quality=high for all)');
    return lines;
  }
}
