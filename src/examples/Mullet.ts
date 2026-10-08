import type { FrameInfo } from '../app/App';
import { addHairParamFolders, addSimulationControls, num, toggle } from '../app/Gui';
import { DragSpring } from '../app/Interaction';
import { MusicPanel } from '../app/MusicPanel';
import { motionForTrack } from '../audio/library';
import { applyHairColor, hairColorOptions, type HairColorName } from '../hair/colorPresets';
import type { ShadingParams } from '../hair/params';
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
    paused: false,
    hairColor: 'brown' as HairColorName,
  };
  private shadingDefaults!: Record<keyof MulletParams, ShadingParams>;
  private rebuildTimer = 0;
  private music!: MusicPanel;
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
    await loadHead();
    this.character = await MulletCharacter.create({
      name: 'wayne',
      hair,
      params: this.params,
      groom: this.groom,
      strandScale: quality.strandScale,
      guideScale: quality.guideScale,
      plinthHeight: 0.8,
    });
    app.scene.add(this.character.root, this.character.colliderDebug.group);
    this.character.motion = this.settings.motion;
    // Drag shakes the bust (not the plinth).
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

    const sync = () => {
      for (const grp of this.character.hair.groups) grp.syncParams();
      this.character.scalpTint.value.set(this.params.business.shading.rootColor);
    };
    const f = gui.folder('Wayne', true);
    const motionBinding = f
      .addBinding(this.settings, 'motion', {
        options: {
          still: 'still',
          idle: 'idle',
          nod: 'nod',
          headbang: 'headbang',
          roxbury: 'roxbury',
          'look around': 'lookAround',
        },
      })
      .on('change', () => {
        this.character.motion = this.settings.motion;
        this.autoMotion = false;
      });
    num(
      f,
      this.settings,
      'tempo',
      { min: 0.3, max: 4, label: 'tempo (no music)' },
      () => (this.character.tempo = this.settings.tempo),
    );
    num(
      f,
      this.settings,
      'amount',
      { min: 0, max: 1.6, label: 'motion amount' },
      () => (this.character.amount = this.settings.amount),
    );

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
    // When the music stops, a motion the track picked goes back to idle (or still); yours keeps going.
    this.music.onStop = () => {
      if (this.autoMotion) setMotion(this.motionBeforeMusic);
    };

    const hairFolder = gui.folder('Hair', false);
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
    num(g, this.groom, 'hairlineOffset', { min: -0.6, max: 0.8, label: 'hairline' }, rebuild);
    num(g, this.groom, 'topLength', { min: 0.01, max: 0.15, label: 'top length' }, rebuild);
    num(g, this.groom, 'frontLength', { min: 0.01, max: 0.15, label: 'front length' }, rebuild);
    num(g, this.groom, 'sideLength', { min: 0.005, max: 0.1, label: 'side length' }, rebuild);
    num(g, this.groom, 'backLength', { min: 0.05, max: 0.45, label: 'party length' }, rebuild);
    num(g, this.groom, 'partyStart', { min: 90, max: 150, label: 'party start (°)' }, rebuild);
    num(g, this.groom, 'partyTop', { min: 0.5, max: 3.5, label: 'party top' }, rebuild);
    num(g, this.groom, 'lift', { min: 0, max: 1, label: 'feather lift' }, rebuild);
    num(g, this.groom, 'perm', { min: 0, max: 0.03, label: 'perm wave' }, rebuild);
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

    // The groom groups share one set of folders, switched with tabs.
    const groups = hairFolder.addTab({ pages: [{ title: 'Business' }, { title: 'Party' }] });
    addHairParamFolders(groups.pages[0], this.params.business, sync);
    addHairParamFolders(groups.pages[1], this.params.party, sync);
    sync();

    const debug = gui.folder('Debug', false);
    toggle(
      debug,
      this.settings,
      'showBody',
      () => (this.character.mesh.visible = this.settings.showBody),
      'show bust',
    );
    toggle(debug, this.settings, 'showStrands', () => this.applyVisibility(), 'show hair');
    toggle(debug, this.settings, 'showGuides', () => this.applyVisibility(), 'show guides');
    toggle(
      debug,
      this.settings,
      'showColliders',
      () => (this.character.colliderDebug.group.visible = this.settings.showColliders),
      'show colliders',
    );
    addSimulationControls(debug, hair, this.settings);
  }

  private applyVisibility(): void {
    this.character.hair.setVisibility(this.settings.showStrands, this.settings.showGuides);
  }

  private scheduleRegroom(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.character.groom(), 300);
  }

  update(info: FrameInfo): void {
    this.music.update(info.dt);
    this.character.beatDivision = this.music.sync.division;
    this.drag.update(info.dt);
    this.character.update(info.dt);
  }

  hud(): string[] {
    return [`wayne   motion ${this.settings.motion}`, this.music.hud()];
  }
}
