import type { FolderApi } from 'tweakpane';

import type { FrameInfo } from '../app/App';
import { addHairBasics, addHairFolders, addWindFolder, alphabetical, num, toggle } from '../app/Gui';
import { DragSpring } from '../app/Interaction';
import { MusicPanel } from '../app/MusicPanel';
import { motionForTrack } from '../audio/library';
import { applyHairColor, hairColorOptions, type HairColorName } from '../hair/colorPresets';
import { hairWind, type ShadingParams } from '../hair/params';
import type { Example, ExampleContext } from './Example';
import {
  MulletCharacter,
  createMulletParams,
  defaultMulletGroom,
  loadHead,
  type HeadMotion,
  type MulletGroomParams,
  type MulletParams,
} from './MulletCharacter';

/** Wayne, a simulated 1980s mullet on the Lee Perry-Smith head scan (CC BY 3.0). */
export class MulletExample implements Example {
  readonly title = 'Wayne';
  private character!: MulletCharacter;
  private drag!: DragSpring;
  private params!: MulletParams;
  private readonly groom: MulletGroomParams = defaultMulletGroom();
  private readonly settings = {
    motion: 'idle' as HeadMotion,
    tempo: 2.1,
    amount: 1,
    showBody: true,
    showStrands: true,
    showGuides: false,
    showColliders: false,
    hairColor: 'brown' as HairColorName,
  };
  private shadingDefaults!: Record<keyof MulletParams, ShadingParams>;
  private rebuildTimer = 0;
  private music!: MusicPanel;
  /** Under the examples menu: plays What Is Love (and stops it), without opening the debug panel. */
  private readonly party = document.createElement('button');
  private partying = false;
  /** The party turned the wind on, so it turns it off again when it ends (a wind you turned on stays on). */
  private partyWind = false;
  private windFolder!: FolderApi;
  /** The current motion was picked for the playing track (not by you), so the next track may replace it. */
  private autoMotion = false;
  /** Motion to return to when the music stops (what the head did before a track picked one). */
  private motionBeforeMusic: HeadMotion = 'idle';

  async init(ctx: ExampleContext): Promise<void> {
    const { app, gui, hair, lights, quality } = ctx;
    this.params = createMulletParams(quality.substeps);
    this.shadingDefaults = {
      business: { ...this.params.business.shading },
      party: { ...this.params.party.shading },
    };
    await ctx.loading.step('Loading head scan…');
    await loadHead();
    await ctx.loading.step('Growing hair…');
    this.character = await MulletCharacter.create({
      name: 'wayne',
      hair,
      params: this.params,
      groom: this.groom,
      strandScale: quality.strandScale,
      guideScale: quality.guideScale,
      baseHeight: 0.8,
    });
    app.scene.add(this.character.root, this.character.colliderDebug.group);
    this.character.motion = this.settings.motion;
    // Drag shakes the bust.
    this.drag = new DragSpring(app, this.character.bust, () => [this.character.mesh]);
    this.drag.stiffness = 160;
    this.drag.damping = 16;

    app.camera.position.set(0.55, 1.13, 0.79);
    app.controls.target.set(0, 1.04, 0.04);
    lights.focus.set(0, 1.0, 0.04);
    lights.focusRadius = 0.8;
    lights.params.keyAzimuth = 40;
    lights.params.keyElevation = 40;
    lights.apply();
    // Wind starts off (the party turns it on); turned on, a gusty breeze from the front, slightly above, streams the
    // party hair back.
    Object.assign(hairWind.params, {
      strength: 6.52,
      azimuth: 11.74,
      elevation: 9.78,
      turbulence: 0.37,
      frequency: 0.8,
      gust: 1.13,
    });
    hairWind.sync();

    const sync = () => {
      for (const grp of this.character.hair.groups) grp.syncParams();
      this.character.scalpTint.value.set(this.params.business.shading.rootColor);
    };
    const f = gui.folder('Wayne');
    const motionBinding = f
      .addBinding(this.settings, 'motion', {
        options: alphabetical({
          still: 'still',
          idle: 'idle',
          nod: 'nod',
          headbang: 'headbang',
          roxbury: 'roxbury',
          'look around': 'lookAround',
        }),
      })
      .on('change', () => {
        this.character.motion = this.settings.motion;
        this.autoMotion = false;
      });
    num(
      f,
      this.settings,
      'tempo',
      {
        min: 0.3,
        max: 4,
        label: 'speed',
        hint: 'Tempo of the head motion when no music is playing (music sets its own).',
      },
      () => (this.character.tempo = this.settings.tempo),
    );
    num(
      f,
      this.settings,
      'amount',
      { min: 0, max: 2, label: 'amount' },
      () => (this.character.amount = this.settings.amount),
    );

    const hairFolder = gui.folder('Hair');
    hairFolder
      .addBinding(this.settings, 'hairColor', { label: 'hair color', options: hairColorOptions() })
      .on('change', () => {
        for (const k of ['business', 'party'] as const)
          applyHairColor(this.params[k].shading, this.shadingDefaults[k], this.settings.hairColor);
        sync();
        gui.pane.refresh();
      });
    const g = gui.folder('Groom (regrows hair)', false, hairFolder);
    const rebuild = () => this.scheduleRegroom();
    num(
      g,
      this.groom,
      'hairlineOffset',
      { min: -0.6, max: 0.8, label: 'hairline', hint: 'Moves the hairline: positive lowers it.' },
      rebuild,
    );
    num(g, this.groom, 'topLength', { min: 1, max: 15, scale: 100, label: 'top length (cm)' }, rebuild);
    num(g, this.groom, 'frontLength', { min: 1, max: 15, scale: 100, label: 'front length (cm)' }, rebuild);
    num(g, this.groom, 'sideLength', { min: 0.5, max: 10, scale: 100, label: 'side length (cm)' }, rebuild);
    num(g, this.groom, 'backLength', { min: 5, max: 45, scale: 100, label: 'party length (cm)' }, rebuild);
    num(
      g,
      this.groom,
      'partyStart',
      {
        min: 90,
        max: 150,
        label: 'party start (°)',
        hint: 'Where the long back starts, in degrees from the front.',
      },
      rebuild,
    );
    num(
      g,
      this.groom,
      'partyTop',
      {
        min: 0.5,
        max: 3.5,
        label: 'party height',
        hint: 'How far the long back reaches up the back of the head.',
      },
      rebuild,
    );
    num(
      g,
      this.groom,
      'lift',
      { min: 0, max: 1, label: 'feather lift', hint: 'How much the top is blown up and back.' },
      rebuild,
    );
    num(g, this.groom, 'perm', { min: 0, max: 30, scale: 1000, label: 'perm wave (mm)' }, rebuild);
    num(
      g,
      this.groom,
      'businessGuides',
      { min: 200, max: 6000, step: 50, label: 'business guides' },
      rebuild,
    );
    num(
      g,
      this.groom,
      'businessStrands',
      { min: 5000, max: 200000, step: 1000, label: 'business strands' },
      rebuild,
    );
    num(g, this.groom, 'partyGuides', { min: 100, max: 4000, step: 50, label: 'party guides' }, rebuild);
    num(
      g,
      this.groom,
      'partyStrands',
      { min: 2000, max: 120000, step: 1000, label: 'party strands' },
      rebuild,
    );

    // Wind is shared by both groups, so it sits above their tabs.
    this.windFolder = addWindFolder(gui.pane);
    // Each groom group has its own Basics and folders, switched with tabs.
    const groups = hairFolder.addTab({ pages: [{ title: 'Business (top)' }, { title: 'Party (back)' }] });
    (['business', 'party'] as const).forEach((k, i) => {
      addHairBasics(groups.pages[i], this.params[k], sync);
      addHairFolders(groups.pages[i], this.params[k], sync);
    });
    sync();

    this.music = new MusicPanel(gui);
    this.character.beatClock = this.music.beat;
    this.character.loudness = this.music.loudness;
    const setMotion = (motion: HeadMotion) => {
      this.settings.motion = motion;
      this.character.motion = motion;
      motionBinding.refresh(); // may fire 'change', which clears autoMotion
      this.autoMotion = false;
    };
    this.music.onPlay = (source) => {
      // An idle or still head takes the track's own motion (see MUSIC_LIBRARY). A motion you picked is kept
      // and locks to the beat.
      if (this.autoMotion || this.settings.motion === 'idle' || this.settings.motion === 'still') {
        if (!this.autoMotion) this.motionBeforeMusic = this.settings.motion;
        setMotion(motionForTrack(source));
        this.autoMotion = true;
      }
    };
    // When the music stops, a motion the track picked reverts to the one before it; yours keeps going.
    this.music.onStop = () => {
      if (this.autoMotion) setMotion(this.motionBeforeMusic);
    };

    const bar = document.createElement('div');
    bar.id = 'party';
    this.party.textContent = 'Press to party';
    this.party.title = 'Play What Is Love, with the wind blowing (M plays and stops the music too)';
    this.party.onclick = () => void this.music.toggleSource('what-is-love');
    bar.appendChild(this.party);
    document.body.appendChild(bar);
  }

  viewControls(f: FolderApi): void {
    toggle(
      f,
      this.settings,
      'showBody',
      () => (this.character.mesh.visible = this.settings.showBody),
      'show bust',
    );
    toggle(f, this.settings, 'showStrands', () => this.applyVisibility(), 'show hair');
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
      'Show the shapes the hair collides with.',
    );
  }

  private applyVisibility(): void {
    this.character.hair.setVisibility(this.settings.showStrands, this.settings.showGuides);
  }

  /** The wind blows while the party lasts (however the music started or stopped). */
  private setPartyWind(on: boolean): void {
    const w = hairWind.params;
    if (on && !w.enabled) this.partyWind = true;
    else if (!on && this.partyWind) this.partyWind = false;
    else return;
    w.enabled = on;
    hairWind.sync();
    this.windFolder.refresh();
  }

  private scheduleRegroom(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.character.groom(), 300);
  }

  update(info: FrameInfo): void {
    this.music.update(info.realDt);
    const p = this.music.player;
    const partying = p.source === 'what-is-love' && (p.playing || p.pending);
    if (partying !== this.partying) {
      this.partying = partying;
      this.party.classList.toggle('active', partying);
      this.party.textContent = partying ? 'Stop the party' : 'Press to party';
      this.setPartyWind(partying);
    }
    this.character.beatDivision = this.music.sync.division;
    this.drag.update(info.dt);
    this.character.update(info.dt);
  }

  hud(): string[] {
    return [`motion ${this.settings.motion}`, this.music.hud()];
  }
}
