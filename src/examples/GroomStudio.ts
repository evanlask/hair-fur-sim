import * as THREE from 'three/webgpu';
import type { FolderApi } from 'tweakpane';

import type { FrameInfo } from '../app/App';
import { addWindFolder, alphabetical, num, tip, toggle } from '../app/Gui';
import { DragSpring } from '../app/Interaction';
import { count } from '../app/Stats';
import type { FieldName } from '../hair/groom/styles/paintedStyle';
import { modHeld } from '../util/platform';
import type { Example, ExampleContext } from './Example';
import { MAP_LENGTH_MAX, TOOL_CHANNELS, isShapeTool, type PaintTool, type Tool } from './studio/brushes';
import { curvesUsda, type CurveExport, type LayerCurves } from './studio/curveExport';
import {
  decodeDocument,
  documentProblem,
  encodeDocument,
  storageKey,
  type GroomDocument,
} from './studio/document';
import { STUDIO_HEAD } from './studio/heads';
import { applyFlowPreset, scalpDensity, type FlowPreset } from './studio/headSpace';
import { diffChange, History, writeValues, type Change, type PaintChange } from './studio/history';
import { LayerGroom } from './studio/layerGroom';
import { LAYER_COLORS, emptyLayer, newLayerId, type Layer } from './studio/layers';
import type { LayerAction } from './studio/layerSection';
import { updateOverlay, updateScalpTint } from './studio/overlay';
import { PaintController } from './studio/PaintController';
import { STARTERS, starterById } from './studio/starters';
import { StudioBust } from './studio/StudioBust';
import { LayerFolders } from './studio/studioGui';
import { MOD, StudioPanel, TOOLS, type CameraView } from './studio/StudioPanel';

/** Height of the bust's base above the floor (m), matching the Mullet example's head. */
const BUST_HEIGHT = 0.8;

type Motion = 'still' | 'turntable' | 'lookAround' | 'shake';

const k = (...keys: string[]) => keys.map((x) => `<kbd>${x}</kbd>`).join(' ');
const rows = (r: [string, string][]) =>
  `<table>${r.map(([key, what]) => `<tr><td>${key}</td><td>${what}</td></tr>`).join('')}</table>`;

/** The studio's Help (replaces the general one): what it is, how to start, then every shortcut by task. */
const HELP = `
<div class="studio-help">
  <p>Paint hair onto the head. A hairstyle is made of <b>layers</b> (say the top, the sides and a fringe), and each
    layer has its own hair, look and movement.</p>
  <ol class="start">
    <li>Pick a style under <i>Styles &amp; files</i> and press <i>Apply</i>, or press <i>+ Add layer</i> to start
      from nothing.</li>
    <li>Choose a tool and drag on the head to paint.</li>
    <li>Press ${k('Q')} to look around and watch the hair move.</li>
  </ol>
  <p>Your work saves in this browser as you go.</p>
  <div class="cols">
    <section><h3>Tools</h3>${rows([
      [k('Q'), 'Navigate: look around, the hair moves'],
      [k('D'), 'Density: where hair grows'],
      [k('L'), 'Length: how long it is'],
      [k('C'), 'Comb: which way it lies'],
      [k('P'), 'Part: make a parting'],
      [k('R'), 'Lift: how much it stands up'],
      [k('B'), 'Bend: how much it curves and droops'],
      [k('W'), 'Wave: how wavy it is'],
      [k('S'), 'Smooth: even out what you painted'],
      [k('N'), 'Noise: make it a little messy'],
      [k('Tab'), 'switch between Navigate and your last tool'],
      [`hold ${k('Space')}`, 'look around for a moment'],
    ])}</section>
    <section><h3>Painting</h3>${rows([
      ['drag', 'paint'],
      [`${k(MOD)} drag`, 'do the opposite: erase, shorten, flatten, straighten'],
      [`${k('Shift')} drag`, 'smooth'],
      [`${k('Alt')} drag`, 'turn the view, even over the head'],
      [k('[', ']'), 'brush size (each tool remembers its own)'],
      [`${k('Shift')} ${k('[', ']')}`, 'brush strength'],
      [k('X'), 'paint both sides at once'],
      [`hold ${k('I')}, click`, 'copy the value under the cursor'],
      [k('Esc'), 'undo the stroke you are painting'],
    ])}</section>
    <section><h3>Layers</h3>${rows([
      [k('↑', '↓'), 'pick the layer above or below'],
      [`${k('Shift')} ${k('↑', '↓')}`, 'move the layer up or down (or drag it in the list)'],
      [`${k('Shift')} ${k('A')}`, 'add a layer'],
      [`${k('Shift')} ${k('D')}`, 'copy the layer'],
      [k('Delete'), 'delete the layer'],
      [`${k('Shift')} ${k('V')}`, 'hide or show the layer'],
      [`${k('Shift')} ${k('S')}`, 'show only this layer'],
      [`${k('Shift')} ${k('L')}`, 'lock the layer (no painting)'],
      ['double-click', 'rename the layer (in the list)'],
    ])}</section>
    <section><h3>View &amp; files</h3>${rows([
      [k('1', '2', '3', '4'), 'front, side, back, top'],
      [k('F'), 'fit the head in view'],
      [k('V'), 'hide or show all hair, to see your painting'],
      [k('G'), 'show the guide hairs (the ones the physics moves)'],
      [k('O'), 'hide or show the painted colours'],
      [`${k(MOD)} drag`, 'in Navigate: shake the head'],
      [`${k(MOD)} ${k('Z')}`, 'undo'],
      [`${k('Shift')} ${k(MOD)} ${k('Z')}`, 'redo'],
      [`${k(MOD)} ${k('S')}`, 'save now'],
      [`${k(MOD)} ${k('O')}`, 'open a groom file'],
      [k('H'), 'this help'],
    ])}</section>
  </div>
  <ul class="tips">
    <li>While you paint, the hair holds still in its styled shape. Press ${k('Q')} to let it move.</li>
    <li><i>Fill scalp</i> grows hair over the whole scalp at once; <i>Fill value</i> sets a whole layer to the brush's
      value.</li>
    <li><i>Export…</i> saves the groom to open again later, or as curves for Houdini, Maya or Blender.</li>
    <li>More settings for the selected layer are under <i>Advanced</i>.</li>
  </ul>
</div>`;

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // Revoking right after click() can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** Groom Studio: paint hair onto a bust in layers, each a hair group grown from its painted maps. */
export class GroomStudioExample implements Example {
  readonly title = 'Groom Studio';
  readonly ownsState = true;
  readonly help = HELP;
  readonly helpOnly = true;
  private ctx!: ExampleContext;
  private bust!: StudioBust;
  private groom!: LayerGroom;
  private paint!: PaintController;
  private panel!: StudioPanel;
  private folders!: LayerFolders;
  private history!: History;
  private drag!: DragSpring;
  private activeId: string | null = null;
  private solo: string | null = null;
  private time = 0;
  private yaw = 0;
  private overlayDirty = true;
  private tintDirty = true;
  private tintAt = 0;
  private listDirty = true;
  private readoutAt = 0;
  private readonly regrowTimers = new Map<string, number>();
  /** A camera move in progress (views, framing): position and orbit target eased over a third of a second. */
  private view: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    t: number;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null = null;
  private saveTimer = 0;
  /** Set when the browser refused the autosave (storage full). */
  private saveError = '';
  private readonly settings = {
    motion: 'still' as Motion,
    speed: 1,
    groomedWhilePainting: true,
    overlayOpacity: 0.85,
    showBody: true,
    showStrands: true,
    showGuides: false,
    showColliders: false,
    physics: true,
  };

  async init(ctx: ExampleContext): Promise<void> {
    this.ctx = ctx;
    const { app, gui, hair, lights, loading, quality } = ctx;
    await loading.step('Loading head…');
    const head = STUDIO_HEAD;
    const assets = await head.load();
    await loading.step('Preparing the bust…');
    this.bust = new StudioBust(head, assets, BUST_HEIGHT);
    app.scene.add(this.bust.root, this.bust.colliderDebug.group);
    this.groom = new LayerGroom(
      this.bust,
      hair,
      { renderer: app.renderer, camera: app.camera, scene: app.scene },
      quality,
    );
    this.groom.onRegrown = () => {
      this.listDirty = true;
      this.updateCounts();
    };
    this.history = new History((c, values) => this.applyPaintChange(c, values));

    await loading.step('Growing hair…');
    // A new session starts bald: paint layers, or apply a style.
    this.groom.layers.push(...(this.loadSaved() ?? []));
    for (const l of this.groom.layers) this.trackLayer(l);
    this.groom.rebuildAll();
    this.activeId = this.groom.layers[0]?.id ?? null;

    // ⌘ / Ctrl-drag on the bust in the Navigate tool grabs and shakes it (it springs back); a plain drag orbits.
    app.container.addEventListener('pointerdown', this.noteGrabKey, { capture: true });
    this.drag = new DragSpring(app, this.bust.pivot, () =>
      this.paint.tool === 'navigate' && this.grabKey ? [this.bust.mesh] : [],
    );
    this.drag.stiffness = 160;
    this.drag.damping = 16;

    this.paint = new PaintController(app, this.bust, {
      layer: () => this.activeLayer,
      painted: (layer, tool, density, centers, radius) => this.painted(layer, tool, density, centers, radius),
      strokeEnded: (layer, density, change, cancelled) => this.strokeEnded(layer, density, change, cancelled),
      picked: () => this.panel.refreshBrush(),
      notice: (text) => this.showNotice(text),
    });
    this.panel = new StudioPanel(this.paint.brush, this.settings, STARTERS, {
      params: (l) => this.paramsChanged(l, 'panel'),
      regrow: (l) => this.scheduleRegrow(l),
      reshape: (l) => this.lengthsChanged(l),
      renamed: (l) => this.renamed(l),
      action: (l, a, preset) => this.layerAction(l, a, preset),
      applyStarter: (id) => {
        const s = starterById(id);
        if (s) this.replaceLayers(this.starterLayers(id), `apply ${s.label}`);
      },
      clearAll: () => this.replaceLayers([], 'clear all layers'),
      exportGroom: () => this.exportGroom(),
      exportCurves: (what) => void this.exportCurves(what),
      importGroom: () => this.importGroom(),
      displayChanged: () => this.displayChanged(),
      frame: () => this.frameHead(),
      setTool: (t) => this.setTool(t),
      brushChanged: () => this.overlayDirtyForBrush(),
      selectLayer: (id) => this.select(id),
      toggleVisible: (id) => this.toggleVisible(id),
      toggleSolo: (id) => this.toggleSolo(id),
      toggleLock: (id) => this.toggleLock(id),
      addLayer: () => this.addLayer(),
      duplicateLayer: () => this.duplicateLayer(),
      deleteLayer: () => this.deleteLayer(),
      moveLayer: (d) => this.moveLayer(d),
      reorderLayer: (id, index) => this.reorderLayer(id, index),
      undo: () => this.undo(),
      redo: () => this.redo(),
      view: (v) => this.setView(v),
    });
    this.history.onChange = () => {
      const h = this.history;
      this.panel.setHistory(h.undoLabel, h.redoLabel);
      this.saveSoon();
    };
    this.panel.setHistory(null, null);

    app.camera.position.copy(head.camera.position);
    app.controls.target.copy(head.camera.target);
    lights.focus.copy(head.camera.target);
    lights.focusRadius = 0.8;
    lights.params.keyAzimuth = 40;
    lights.params.keyElevation = 40;
    lights.apply();

    this.addStudioFolder();
    this.folders = new LayerFolders(this.panel.advanced, (id) => this.groom.layer(id), {
      regrow: (l) => this.scheduleRegrow(l),
      params: (l) => this.paramsChanged(l, 'details'),
    });
    for (const l of this.groom.layers) this.folders.add(l);
    addWindFolder(gui.pane);
    this.updateCounts();
    this.select(this.activeId);
    this.setTool('navigate');
    if (this.restoreProblem) this.showNotice(this.restoreProblem, 10_000);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Leaving or reloading the page (e.g. another quality preset) keeps the latest edits.
    window.addEventListener('pagehide', () => this.saveTimer && this.save());
  }

  private get activeLayer(): Layer | null {
    return this.groom.layers.find((l) => l.id === this.activeId) ?? null;
  }

  /** The bust's motion while navigating (the grooming display settings are in the left panel). */
  private addStudioFolder(): void {
    const f = this.ctx.gui.folder('Groom Studio', true);
    tip(
      f.addBinding(this.settings, 'motion', {
        options: alphabetical({
          still: 'still',
          turntable: 'turntable',
          'look around': 'lookAround',
          shake: 'shake',
        }),
      }),
      'How the bust moves while you navigate (it holds still while you paint).',
    );
    num(f, this.settings, 'speed', { min: 0.1, max: 2, label: 'speed' }, () => {});
    this.bust.overlayOpacity.value = this.settings.overlayOpacity;
  }

  /** The left panel's display settings changed (hair and guides shown, map opacity, pausing the physics). */
  private displayChanged(): void {
    this.bust.overlayOpacity.value = this.settings.overlayOpacity;
    this.applyGroomedShape();
    this.applyVisibility();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Saving

  private starterLayers(id: string): Layer[] {
    return starterById(id)?.build(this.bust, this.ctx.quality.substeps) ?? [];
  }

  /**
   * The autosaved groom, if there is one that fits, with every layer shown: one hidden last time (Shift+V is easy to
   * press by accident) would reopen as a bald head under a layer list that says there's hair.
   */
  private loadSaved(): Layer[] | null {
    try {
      const text = localStorage.getItem(storageKey(this.bust.head.id));
      if (!text) return null;
      const doc = JSON.parse(text) as GroomDocument;
      const problem = documentProblem(doc, this.bust);
      if (problem) {
        this.restoreProblem = `Couldn't reopen your last groom: ${problem}. Apply a style or import a file.`;
        return null;
      }
      const layers = decodeDocument(doc, this.bust, this.ctx.quality.substeps);
      for (const l of layers) l.visible = true;
      return layers;
    } catch (err) {
      console.warn('[fursim] could not restore the saved groom', err);
      this.restoreProblem = "Couldn't reopen your last groom. Apply a style or import a file.";
      return null;
    }
  }
  /** Why the autosaved groom didn't reopen (shown once the studio is up), if it didn't. */
  private restoreProblem = '';

  /** Autosaves shortly after an edit (coalescing a burst of them). */
  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    try {
      localStorage.setItem(
        storageKey(this.bust.head.id),
        JSON.stringify(encodeDocument(this.bust, this.groom.layers)),
      );
      this.saveError = '';
      this.panel?.setStatus('saved', 'Saved in this browser (it reopens next time). Export to keep a copy.');
    } catch (err) {
      this.saveError = 'autosave failed (browser storage full?): use Export';
      this.panel?.setStatus('not saved', this.saveError, true);
      console.warn('[fursim] autosave failed', err);
    }
  }

  private exportGroom(): void {
    const doc = encodeDocument(this.bust, this.groom.layers);
    download(
      new Blob([JSON.stringify(doc)], { type: 'application/json' }),
      `groom-${this.bust.head.id}.json`,
    );
  }

  /** Downloads the visible layers' guides or drawn strands as USD curves (see curvesUsda). */
  private async exportCurves(what: CurveExport): Promise<void> {
    this.showNotice(`exporting ${what}…`, 10_000);
    try {
      const text = await this.curvesText(what);
      download(new Blob([text], { type: 'text/plain' }), `groom-${this.bust.head.id}-${what}.usda`);
      this.showNotice(`exported ${what} (${(text.length / 1e6).toFixed(1)} MB of USD curves)`, 4000);
    } catch (err) {
      console.warn('[fursim] curve export failed', err);
      this.showNotice(`Could not export: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }

  /**
   * The visible layers' curves as USD text, read back from the GPU as they are drawn now, in the head's model units.
   * For strands, culling and level of detail are off for a few frames so every strand is there.
   */
  private async curvesText(what: CurveExport): Promise<string> {
    const inst = this.groom.instance;
    const groups = (inst?.groups ?? []).filter((g) => g.enabled);
    if (!groups.length) throw new Error('there is no hair to export');
    const restore: (() => void)[] = [];
    if (what === 'strands') {
      for (const g of groups) {
        const st = g.params.style;
        const saved = { ...st };
        Object.assign(st, {
          lodEnabled: false,
          cullOffscreen: false,
          lodDistance: 0,
          backCull: 0,
          lodSubpixelDensity: 1,
          density: 1,
        });
        g.syncParams();
        restore.push(() => {
          Object.assign(st, saved);
          g.syncParams();
        });
      }
    }
    this.exporting = true;
    try {
      // A few frames for every strand to be interpolated and drawn again.
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      const renderer = this.ctx.app.renderer;
      const toModel = this.bust.model.matrixWorld.clone().invert();
      const scale = this.bust.head.scale;
      const p = new THREE.Vector3();
      const layers: LayerCurves[] = [];
      for (const g of groups) {
        const layer = this.groom.layer(g.name);
        const { G, Ng, R, Ns } = g.ctx;
        const node = (what === 'strands' ? g.ctx.renderPos : g.ctx.guidePos) as unknown as {
          value: THREE.BufferAttribute;
        };
        const data = new Float32Array(await renderer.getArrayBufferAsync(node.value));
        const perCurve = what === 'strands' ? R : G;
        const curves = what === 'strands' ? Ns : Ng;
        const points = new Float32Array(curves * perCurve * 4);
        const guideWidth = (layer?.params.style.rootWidth ?? 0.0001) / scale;
        for (let i = 0; i < curves * perCurve; i++) {
          p.fromArray(data, i * 4).applyMatrix4(toModel);
          points.set([p.x, p.y, p.z, what === 'strands' ? data[i * 4 + 3] / scale : guideWidth], i * 4);
        }
        const c = new THREE.Color(layer?.params.shading.rootColor ?? '#2a1a10');
        layers.push({ name: layer?.name ?? g.name, points, curves, perCurve, color: [c.r, c.g, c.b] });
      }
      return curvesUsda(layers, what, this.bust.head.label, scale);
    } finally {
      this.exporting = false;
      for (const r of restore) r();
    }
  }
  /** Holds the bust still while curves are read back (they're converted with this frame's transform). */
  private exporting = false;

  private importGroom(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const doc = JSON.parse(await file.text()) as GroomDocument;
        const problem = documentProblem(doc, this.bust);
        if (problem) throw new Error(`this groom was ${problem}`);
        this.replaceLayers(decodeDocument(doc, this.bust, this.ctx.quality.substeps), `import ${file.name}`);
      } catch (err) {
        console.warn('[fursim] could not import the groom', err);
        this.showNotice(
          `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
          6000,
        );
      }
    };
    input.click();
  }

  /** Replaces every layer at once (starter styles, imports), as one undoable step. */
  private replaceLayers(next: Layer[], label: string): void {
    this.commitSettingsEdits();
    const before = [...this.groom.layers];
    const swap = (layers: Layer[]) => {
      for (const l of this.groom.layers) this.folders.remove(l);
      this.groom.layers.splice(0, this.groom.layers.length, ...layers);
      for (const l of layers) {
        this.folders.add(l);
        this.trackLayer(l);
      }
      this.solo = null;
      void this.ctx.loading.busy('Growing hair…', () => {
        this.groom.rebuildAll();
        this.applyGroomedShape();
        this.applyVisibility();
      });
      this.select(layers[0]?.id ?? null);
      this.tintDirty = true;
      this.listDirty = true;
    };
    swap(next);
    this.pushLayerChange(
      label,
      () => swap(before),
      () => swap(next),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tools and painting

  private setTool(tool: Tool): void {
    if (this.paint.painting) this.paint.cancel();
    if (tool !== 'navigate') this.lastPaintTool = tool;
    this.paint.tool = tool;
    this.panel.setTool(tool);
    this.paint.cursor.setColor(this.activeLayer?.uiColor ?? '#ffffff');
    this.overlayDirty = true;
    this.applyGroomedShape();
    this.applyVisibility();
  }

  /** Paint tools show the groomed (rest) shape; Navigate lets the physics run. */
  private applyGroomedShape(): void {
    const inst = this.groom.instance;
    if (inst)
      inst.simulate =
        this.settings.physics && (this.paint.tool === 'navigate' || !this.settings.groomedWhilePainting);
  }

  private overlayDirtyForBrush(): void {
    this.overlayDirty = true;
  }

  private painted(
    layer: Layer,
    _tool: PaintTool,
    density: boolean,
    centers: THREE.Vector3[],
    radius: number,
  ): void {
    this.overlayDirty = true;
    if (density) this.tintDirty = true;
    else this.groom.shapeChanged(layer.id, centers, radius * this.bust.head.scale);
  }

  private strokeEnded(layer: Layer, density: boolean, change: PaintChange | null, cancelled: boolean): void {
    if (change) this.history.push(change);
    if (change || cancelled) {
      if (density) this.groom.densityChanged(layer.id);
      else if (cancelled) this.groom.shapeChanged(layer.id);
    }
    this.overlayDirty = true;
    this.tintDirty = true;
  }

  /** Undo / redo of a paint change: writes its values back and regrows or reshapes the layer. */
  private applyPaintChange(c: PaintChange, values: Float32Array[]): void {
    const layer = this.groom.layer(c.layerId);
    if (!layer) return;
    writeValues(layer.fields, c, values);
    this.fieldsChanged(layer, c.channels);
  }

  private fieldsChanged(layer: Layer, channels: FieldName[]): void {
    if (channels.includes('density')) this.groom.densityChanged(layer.id);
    if (channels.some((c) => c !== 'density')) this.groom.shapeChanged(layer.id);
    this.overlayDirty = true;
    this.tintDirty = true;
  }

  /** Changes whole maps of a layer as one undoable step (keeping just the vertices it changed). */
  private editFields(layer: Layer, channels: FieldName[], label: string, edit: () => void): void {
    const before = channels.map((ch) => layer.fields[ch].slice());
    edit();
    const change = diffChange(layer.fields, layer.id, label, channels, before);
    if (!change) return;
    this.history.push(change);
    this.fieldsChanged(layer, channels);
  }

  private layerAction(layer: Layer, action: LayerAction, preset?: FlowPreset): void {
    const { frame } = this.bust.head;
    const paint = this.bust.paint;
    const f = layer.fields;
    if (layer.locked && action !== 'flow') {
      this.showNotice(`“${layer.name}” is locked: unlock it in the layer list to change it`);
      return;
    }
    switch (action) {
      case 'fill':
        this.editFields(layer, ['density'], 'fill scalp', () => f.density.set(scalpDensity(frame, paint)));
        break;
      case 'fillValue':
        this.fillValue(layer);
        break;
      case 'clear':
        this.editFields(layer, ['density'], 'clear', () => f.density.fill(0));
        break;
      case 'mirror':
      case 'mirrorRL':
        this.editFields(
          layer,
          [...TOOL_CHANNELS.smooth, 'density'],
          action === 'mirror' ? 'mirror left → right' : 'mirror right → left',
          () => this.mirrorSides(layer, action === 'mirror' ? 1 : -1),
        );
        break;
      case 'flow':
        if (layer.locked) {
          this.showNotice(`“${layer.name}” is locked: unlock it in the layer list to change it`);
          return;
        }
        this.editFields(layer, ['flow'], 'comb layer', () =>
          applyFlowPreset(preset ?? 'crown', frame, paint, f.flow),
        );
        break;
    }
  }

  /** Sets the whole layer to the brush value of the current tool (like a flood fill in a paint program). */
  private fillValue(layer: Layer): void {
    const tool = this.paint.tool;
    const v = this.paint.brush.value;
    const f = layer.fields;
    const label = TOOLS.find((t) => t.tool === tool)?.label.toLowerCase() ?? tool;
    switch (tool) {
      case 'density':
        this.editFields(layer, ['density'], `fill density`, () => f.density.fill(v.density));
        break;
      case 'length':
        this.editFields(layer, ['length'], `fill length`, () =>
          f.length.fill(Math.min(MAP_LENGTH_MAX, v.length / layer.settings.lengthScale)),
        );
        break;
      case 'lift':
        this.editFields(layer, ['lift'], `fill lift`, () => f.lift.fill(v.lift));
        break;
      case 'curve':
        this.editFields(layer, ['curve', 'gravity'], `fill bend`, () => {
          f.curve.fill(v.curve);
          f.gravity.fill(this.paint.brush.gravity);
        });
        break;
      case 'wave':
        this.editFields(layer, ['wave'], `fill wave`, () => f.wave.fill(v.wave));
        break;
      default:
        this.showNotice(`${label}: nothing to fill (pick Density, Length, Lift, Bend or Wave)`);
    }
  }

  /**
   * Copies every map from one side of the face onto the other through the mirror map: `from` 1 copies the face's
   * left (+x) onto its right, −1 the right onto the left.
   */
  private mirrorSides(layer: Layer, from: 1 | -1): void {
    const { positions, mirror, count } = this.bust.paint;
    const mid = this.bust.head.frame.midlineX;
    const f = layer.fields;
    for (let i = 0; i < count; i++) {
      if ((positions[i * 3] - mid) * from >= 0) continue;
      const j = mirror[i];
      if (j < 0) continue;
      for (const ch of ['density', 'length', 'lift', 'curve', 'gravity', 'wave'] as const)
        f[ch][i] = f[ch][j];
      f.flow[i * 3] = -f.flow[j * 3];
      f.flow[i * 3 + 1] = f.flow[j * 3 + 1];
      f.flow[i * 3 + 2] = f.flow[j * 3 + 2];
    }
  }

  private undo(): void {
    if (this.paint.painting) return;
    this.commitSettingsEdits();
    const c = this.history.undo();
    this.refreshPanels();
    if (c) this.showNotice(`undid ${c.label}`, 1500);
  }

  private redo(): void {
    if (this.paint.painting) return;
    this.commitSettingsEdits();
    const c = this.history.redo();
    this.refreshPanels();
    if (c) this.showNotice(`redid ${c.label}`, 1500);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Undo for slider changes: a layer's settings and look are snapshot after each committed change; edits that come
  // in a burst (dragging a slider) become one undo step once they pause.

  /** Last committed settings / look of each layer, as JSON. */
  private readonly committed = new Map<string, string>();
  private readonly editTimers = new Map<string, number>();
  private restoring = false;

  private snapshotOf(layer: Layer): string {
    const { name, uiColor, settings, params } = layer;
    return JSON.stringify({ name, uiColor, settings, params });
  }

  /** Remembers a layer's current settings as committed (new layers, after loads and undos). */
  private trackLayer(layer: Layer): void {
    this.committed.set(layer.id, this.snapshotOf(layer));
  }

  /** A slider (either panel) changed a layer: commit it as an undo step once the edits pause. */
  private settingsEdited(layer: Layer): void {
    if (this.restoring) return;
    clearTimeout(this.editTimers.get(layer.id));
    this.editTimers.set(
      layer.id,
      window.setTimeout(() => this.commitSettingsEdit(layer), 600),
    );
  }

  private commitSettingsEdits(): void {
    // (Committing deletes the entry; a Map iterator copes with that.)
    for (const id of this.editTimers.keys()) {
      const l = this.groom.layer(id);
      if (l) this.commitSettingsEdit(l);
      else {
        clearTimeout(this.editTimers.get(id));
        this.editTimers.delete(id);
      }
    }
  }

  private commitSettingsEdit(layer: Layer): void {
    clearTimeout(this.editTimers.get(layer.id));
    this.editTimers.delete(layer.id);
    const before = this.committed.get(layer.id);
    const after = this.snapshotOf(layer);
    this.committed.set(layer.id, after);
    if (!before || before === after) return;
    this.history.push({
      kind: 'action',
      label: `edit ${layer.name}`,
      undo: () => this.restoreSettings(layer, before),
      redo: () => this.restoreSettings(layer, after),
    });
  }

  /** Puts back a layer's settings and look from a snapshot, regrowing or reshaping what that changes. */
  private restoreSettings(layer: Layer, snapshot: string): void {
    const s = JSON.parse(snapshot) as Pick<Layer, 'name' | 'uiColor' | 'settings' | 'params'>;
    const regrow = (
      [
        'hairPerCm2',
        'guideSpacing',
        'guideParticles',
        'strandPoints',
        'lengthVariation',
        'widthVariation',
      ] as const
    ).some((k) => s.settings[k] !== layer.settings[k]);
    const reshape =
      s.settings.lengthScale !== layer.settings.lengthScale ||
      s.settings.waveCount !== layer.settings.waveCount;
    this.restoring = true;
    try {
      layer.name = s.name;
      layer.uiColor = s.uiColor;
      Object.assign(layer.settings, s.settings);
      // Into the existing objects: the panels' controls hold references to them.
      for (const part of ['physics', 'style', 'shading'] as const)
        Object.assign(layer.params[part], s.params[part]);
      this.committed.set(layer.id, snapshot);
      this.groom.instance?.groups.find((g) => g.name === layer.id)?.syncParams();
      if (regrow) this.groom.densityChanged(layer.id);
      else if (reshape) this.groom.shapeChanged(layer.id);
      this.renamed(layer);
      this.tintDirty = true;
      this.refreshPanels();
    } finally {
      this.restoring = false;
    }
    this.saveSoon();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Layers

  private select(id: string | null): void {
    this.commitSettingsEdits();
    this.activeId = id;
    this.folders.show(id);
    this.panel.layer.setLayer(this.activeLayer);
    this.listDirty = true;
    this.overlayDirty = true;
    this.paint.cursor.setColor(this.activeLayer?.uiColor ?? '#ffffff');
  }

  private toggleVisible(id: string): void {
    const l = this.groom.layer(id);
    if (!l) return;
    l.visible = !l.visible;
    this.groom.applyVisibility(this.solo);
    this.listDirty = true;
    this.tintDirty = true;
    this.saveSoon();
  }

  private toggleSolo(id: string): void {
    this.solo = this.solo === id ? null : id;
    this.groom.applyVisibility(this.solo);
    this.listDirty = true;
    this.tintDirty = true;
    this.saveSoon();
  }

  private toggleLock(id: string): void {
    const l = this.groom.layer(id);
    if (!l) return;
    l.locked = !l.locked;
    this.listDirty = true;
    this.saveSoon();
  }

  /** Adds an empty layer with its name field focused and the density brush selected. */
  private addLayer(): void {
    const layers = this.groom.layers;
    const layer = emptyLayer(this.bust, this.ctx.quality.substeps);
    let n = layers.length + 1;
    while (layers.some((l) => l.name === `Layer ${n}`)) n++;
    layer.name = `Layer ${n}`;
    layer.uiColor =
      LAYER_COLORS.find((c) => !layers.some((l) => l.uiColor === c)) ??
      LAYER_COLORS[layers.length % LAYER_COLORS.length];
    const index = this.insertionIndex();
    this.insertLayer(layer, index);
    this.pushLayerChange(
      `add ${layer.name}`,
      () => this.removeLayer(layer),
      () => this.insertLayer(layer, index),
    );
    this.setTool('density');
    this.panel.layer.focusName();
  }

  private duplicateLayer(): void {
    const src = this.activeLayer;
    if (!src) return;
    const f = src.fields;
    const layer: Layer = {
      ...src,
      id: newLayerId(),
      name: `${src.name} copy`,
      settings: { ...src.settings, seed: 1 + Math.floor(Math.random() * 1e6) },
      params: structuredClone(src.params),
      fields: {
        density: f.density.slice(),
        length: f.length.slice(),
        flow: f.flow.slice(),
        lift: f.lift.slice(),
        curve: f.curve.slice(),
        gravity: f.gravity.slice(),
        wave: f.wave.slice(),
      },
    };
    const index = this.insertionIndex();
    this.insertLayer(layer, index);
    this.pushLayerChange(
      `duplicate ${src.name}`,
      () => this.removeLayer(layer),
      () => this.insertLayer(layer, index),
    );
  }

  private deleteLayer(): void {
    const layer = this.activeLayer;
    if (!layer) return;
    const index = this.groom.layers.indexOf(layer);
    this.removeLayer(layer);
    this.pushLayerChange(
      `delete ${layer.name}`,
      () => this.insertLayer(layer, index),
      () => this.removeLayer(layer),
    );
  }

  private moveLayer(delta: -1 | 1): void {
    const layer = this.activeLayer;
    if (layer) this.reorderLayer(layer.id, this.groom.layers.indexOf(layer) + delta);
  }

  /** Moves a layer to `to` in the list (the arrows, Shift+↑ / ↓, or a drag in the list), as one undoable step. */
  private reorderLayer(id: string, to: number): void {
    const layer = this.groom.layer(id);
    if (!layer) return;
    const from = this.groom.layers.indexOf(layer);
    if (to === from || to < 0 || to >= this.groom.layers.length) return;
    const move = (a: number, b: number) => {
      this.groom.layers.splice(a, 1);
      this.groom.layers.splice(b, 0, layer);
      this.listDirty = true;
    };
    move(from, to);
    this.pushLayerChange(
      'move layer',
      () => move(to, from),
      () => move(from, to),
    );
  }

  /** New layers go above the active one. */
  private insertionIndex(): number {
    const i = this.groom.layers.findIndex((l) => l.id === this.activeId);
    return i < 0 ? this.groom.layers.length : i;
  }

  private insertLayer(layer: Layer, index: number): void {
    this.groom.layers.splice(Math.min(index, this.groom.layers.length), 0, layer);
    this.folders.add(layer);
    this.trackLayer(layer);
    this.groom.densityChanged(layer.id);
    this.select(layer.id);
    this.tintDirty = true;
  }

  private removeLayer(layer: Layer): void {
    const i = this.groom.layers.indexOf(layer);
    if (i < 0) return;
    // A slider edit still pending goes in the history before the removal.
    if (this.editTimers.has(layer.id)) this.commitSettingsEdit(layer);
    this.groom.layers.splice(i, 1);
    this.folders.remove(layer);
    this.groom.densityChanged(layer.id);
    if (this.solo === layer.id) {
      this.solo = null;
      this.groom.applyVisibility(null);
    }
    if (this.activeId === layer.id)
      this.select(this.groom.layers[Math.min(i, this.groom.layers.length - 1)]?.id ?? null);
    this.tintDirty = true;
    this.listDirty = true;
  }

  private pushLayerChange(label: string, undo: () => void, redo: () => void): void {
    const change: Change = { kind: 'action', label, undo, redo };
    this.history.push(change);
  }

  private scheduleRegrow(layer: Layer): void {
    this.settingsEdited(layer);
    this.saveSoon();
    clearTimeout(this.regrowTimers.get(layer.id));
    this.regrowTimers.set(
      layer.id,
      window.setTimeout(() => this.groom.densityChanged(layer.id), 300),
    );
  }

  /** Hair params changed in one panel: push them to the GPU and show them in the other. */
  private paramsChanged(layer: Layer, from: 'panel' | 'details'): void {
    this.groom.instance?.groups.find((g) => g.name === layer.id)?.syncParams();
    this.tintDirty = true;
    this.settingsEdited(layer);
    if (!this.syncingPanels) {
      this.syncingPanels = true;
      // Refreshing a Tweakpane folder fires its change handlers: the flag stops them echoing back.
      if (from === 'panel') this.folders.refresh(layer.id);
      else if (layer.id === this.activeId) this.panel.layer.refresh();
      this.syncingPanels = false;
    }
    this.saveSoon();
  }
  private syncingPanels = false;

  /** A layer setting that reshapes its guides (length scale, waves) changed; the skin tint follows the lengths. */
  private lengthsChanged(layer: Layer): void {
    this.groom.shapeChanged(layer.id);
    this.tintDirty = true;
    this.settingsEdited(layer);
    this.saveSoon();
  }

  private renamed(layer: Layer): void {
    this.settingsEdited(layer);
    this.folders.setTitle(layer);
    this.listDirty = true;
    this.overlayDirty = true;
    this.paint.cursor.setColor(this.activeLayer?.uiColor ?? '#ffffff');
    this.saveSoon();
  }

  /** Both panels re-read the active layer (after an undo or a load). */
  private refreshPanels(): void {
    this.panel.layer.refresh();
    if (this.activeId) this.folders.refresh(this.activeId);
  }

  /** Guides and strands each layer grows (shown in the layer list). */
  private layerCounts(): Map<string, { guides: number; strands: number }> {
    return new Map(
      (this.groom.instance?.groups ?? []).map((g) => [g.name, { guides: g.ctx.Ng, strands: g.ctx.Ns }]),
    );
  }

  private updateCounts(): void {
    this.listDirty = true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Keys, views, frame

  private readonly onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    const k = e.key.toLowerCase();
    if (modHeld(e)) {
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (k === 's') {
        e.preventDefault();
        this.commitSettingsEdits();
        this.save();
        this.showNotice(this.saveError || 'saved in this browser (it also saves as you work)');
      } else if (k === 'o') {
        e.preventDefault();
        this.importGroom();
      }
      return;
    }
    // The other modifier (Ctrl on a Mac, Windows/Super elsewhere) isn't a shortcut: don't take it as a plain key.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Hold Space to navigate with any tool (a focused button would also take it as a click).
    if (k === ' ') {
      e.preventDefault();
      if (!e.repeat && this.paint.tool !== 'navigate' && !this.paint.painting) {
        this.spaceTool = this.paint.tool;
        this.setTool('navigate');
      }
      return;
    }
    if (this.layerKey(e, k)) return;
    const brush = this.paint.brush;
    // By key position: with Shift held, the brackets type as { and }.
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const up = e.code === 'BracketRight';
      if (e.shiftKey) brush.strength = THREE.MathUtils.clamp(brush.strength + (up ? 0.1 : -0.1), 0.05, 1);
      else brush.radius = THREE.MathUtils.clamp(brush.radius * (up ? 1.15 : 1 / 1.15), 0.003, 0.08);
      this.panel.refreshBrush();
      return;
    }
    if (e.repeat) return;
    if (k === 'escape') this.paint.cancel();
    else if (k === 'x') {
      brush.mirror = !brush.mirror;
      this.panel.refreshBrush();
    } else if (k === 'v') {
      this.settings.showStrands = !this.settings.showStrands;
      this.applyVisibility();
      this.panel.refreshDisplay();
    } else if (k === 'g') {
      this.settings.showGuides = !this.settings.showGuides;
      this.applyVisibility();
      this.panel.refreshDisplay();
    } else if (k === 'o') {
      // The painted map on / off (back at its opacity before).
      const s = this.settings;
      if (s.overlayOpacity > 0) {
        this.mapOpacity = s.overlayOpacity;
        s.overlayOpacity = 0;
      } else s.overlayOpacity = this.mapOpacity || 0.85;
      this.displayChanged();
      this.panel.refreshDisplay();
    } else if (k === 'tab') {
      e.preventDefault();
      if (this.paint.tool === 'navigate') this.setTool(this.lastPaintTool);
      else this.setTool('navigate');
    } else if (k === 'f') this.frameHead();
    else if (k === 'i') this.paint.eyedropper = true;
    else if (k >= '1' && k <= '4') this.setView((['front', 'side', 'back', 'top'] as CameraView[])[+k - 1]);
    else {
      const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (tool) this.setTool(tool.tool);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'i') this.paint.eyedropper = false;
    if (k === ' ') {
      e.preventDefault();
      if (this.spaceTool && this.paint.tool === 'navigate') this.setTool(this.spaceTool);
      this.spaceTool = null;
    }
  };

  /** The paint tool Space-navigation goes back to. */
  private spaceTool: Tool | null = null;
  /** The paint tool Tab switches back to from Navigate. */
  private lastPaintTool: Tool = 'density';
  /** Map opacity before O hid it. */
  private mapOpacity = 0;

  /** Layer shortcuts (arrows, Shift+A / D / V / S / L, Delete); true if `e` was one. */
  private layerKey(e: KeyboardEvent, k: string): boolean {
    const layers = this.groom.layers;
    const i = layers.findIndex((l) => l.id === this.activeId);
    const active = this.activeLayer;
    if (k === 'arrowup' || k === 'arrowdown') {
      e.preventDefault();
      const d = k === 'arrowup' ? -1 : 1;
      if (e.shiftKey) this.moveLayer(d);
      else if (layers.length) this.select(layers[THREE.MathUtils.clamp(i + d, 0, layers.length - 1)].id);
      return true;
    }
    if ((k === 'delete' || k === 'backspace') && active) {
      e.preventDefault();
      this.deleteLayer();
      this.showNotice(`deleted “${active.name}” (${MOD}Z brings it back)`);
      return true;
    }
    if (!e.shiftKey) return false;
    switch (k) {
      case 'a':
        e.preventDefault(); // the name field takes focus, and would get the A
        this.addLayer();
        return true;
      case 'd':
        this.duplicateLayer();
        return true;
      case 'v':
        // Plain V toggles all the hair; this hides just the layer, so it says so.
        if (active) {
          this.toggleVisible(active.id);
          this.showNotice(
            active.visible ? `showing “${active.name}”` : `hid “${active.name}” (Shift+V shows it again)`,
          );
        }
        return true;
      case 's':
        if (active) this.toggleSolo(active.id);
        return true;
      case 'l':
        if (active) this.toggleLock(active.id);
        return true;
    }
    return false;
  }

  /** ⌘ / Ctrl held as a drag starts: in Navigate, a drag on the bust grabs it instead of orbiting. */
  private grabKey = false;
  private readonly noteGrabKey = (e: PointerEvent) => {
    this.grabKey = modHeld(e);
  };

  /** Brings the whole head into view from where the camera looks now (F, as in most 3D tools). */
  private frameHead(): void {
    const { app } = this.ctx;
    const h = this.bust.head;
    const center = this.bust.model.localToWorld(h.frame.center.clone());
    const radius = Math.max(h.frame.radii.x, h.frame.radii.y, h.frame.radii.z) * h.scale;
    const dir = app.camera.position.clone().sub(app.controls.target).normalize();
    const fov = THREE.MathUtils.degToRad(app.camera.fov);
    const dist = (radius * 1.9) / Math.tan(fov / 2);
    this.view = {
      from: app.camera.position.clone(),
      to: center.clone().addScaledVector(dir, dist),
      t: 0,
      fromTarget: app.controls.target.clone(),
      toTarget: center,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Notices: a line under the brush saying why a click did nothing, what undo just did, or what went wrong.

  private notice: { text: string; until: number } | null = null;

  private showNotice(text: string, ms = 2500): void {
    this.notice = { text, until: performance.now() + ms };
    this.readoutAt = 0;
  }

  /** Swings the camera round the head to look from the front, side, back or top. */
  private setView(v: CameraView): void {
    const { app } = this.ctx;
    const target = app.controls.target;
    const dist = app.camera.position.distanceTo(target);
    const dir = { front: [0, 0.05, 1], side: [1, 0.05, 0], back: [0, 0.05, -1], top: [0, 1, 0.12] }[v];
    const q = new THREE.Quaternion();
    this.bust.pivot.getWorldQuaternion(q);
    const to = new THREE.Vector3(...dir).normalize().applyQuaternion(q).multiplyScalar(dist).add(target);
    this.view = {
      from: app.camera.position.clone(),
      to,
      t: 0,
      fromTarget: target.clone(),
      toTarget: target.clone(),
    };
  }

  /** Debug views (hair, guides and colliders are shown or hidden in the grooming panel). */
  viewControls(f: FolderApi): void {
    toggle(
      f,
      this.settings,
      'showBody',
      () => (this.bust.mesh.visible = this.settings.showBody),
      'show bust',
    );
  }

  private applyVisibility(): void {
    const combing = this.paint?.tool === 'comb' || this.paint?.tool === 'part';
    this.groom.instance?.setVisibility(this.settings.showStrands, this.settings.showGuides || combing);
    this.bust.hairShown.value = this.settings.showStrands ? 1 : 0;
    this.bust.colliderDebug.group.visible = this.settings.showColliders;
  }

  update(info: FrameInfo): void {
    const s = this.settings;
    const painting = this.paint.tool !== 'navigate';
    // The bust holds still while a paint tool is active (and while curves are exported).
    if (!painting && !this.exporting) {
      this.time += info.dt * s.speed;
      const t = this.time;
      switch (s.motion) {
        case 'turntable':
          this.yaw = (this.yaw + info.dt * s.speed * 0.6) % (Math.PI * 2);
          break;
        case 'lookAround':
          this.yaw = Math.sin(t * 0.9) * 0.7;
          break;
        case 'shake':
          this.yaw = Math.sin(t * 9) * 0.22;
          break;
        default:
          this.yaw += (0 - this.yaw) * Math.min(1, info.dt * 4);
      }
    }
    this.bust.pivot.rotation.y = this.yaw;
    this.drag.update(info.dt);
    this.bust.root.updateMatrixWorld(true);
    if (this.view) {
      const v = this.view;
      v.t = Math.min(1, v.t + info.realDt / 0.35);
      const e = v.t * v.t * (3 - 2 * v.t);
      this.ctx.app.camera.position.lerpVectors(v.from, v.to, e);
      this.ctx.app.controls.target.lerpVectors(v.fromTarget, v.toTarget, e);
      if (v.t >= 1) this.view = null;
    }
    this.centerInView();
    this.paint.update();
    this.groom.update();
    if (this.overlayDirty) {
      this.overlayDirty = false;
      updateOverlay(this.bust, this.activeLayer, this.paint.tool);
    }
    // Mid-stroke a few times a second is enough (it walks every layer's maps); the stroke's end updates it fully.
    if (this.tintDirty && (!this.paint.painting || performance.now() - this.tintAt > 100)) {
      this.tintDirty = false;
      this.tintAt = performance.now();
      updateScalpTint(this.bust, this.groom.layers, this.solo);
    }
    if (this.listDirty) {
      this.listDirty = false;
      this.panel.setLayers(this.groom.layers, this.activeId, this.solo, this.layerCounts());
    }
    if (performance.now() - this.readoutAt > 120) {
      this.readoutAt = performance.now();
      this.panel.setReadout(this.readout());
    }
    this.bust.colliderDebug.update();
  }

  /**
   * Shifts the picture (a lens shift, the camera's film offset) so the orbit target sits in the middle of the space
   * the grooming panel leaves, not of the whole window. Picking and TAA's jitter work on top of it.
   */
  private centerInView(): void {
    const cam = this.ctx.app.camera;
    const w = window.innerWidth;
    const shift = Math.min(this.panel.el.getBoundingClientRect().right, w * 0.4) / 2;
    const offset =
      -(shift / w) * cam.getFilmWidth() * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect;
    if (Math.abs(offset - cam.filmOffset) < 1e-4) return;
    cam.filmOffset = offset;
    cam.updateProjectionMatrix();
  }

  /** A notice, or the active layer's values under the cursor. */
  private readout(): string {
    if (this.notice && performance.now() < this.notice.until) return this.notice.text;
    this.notice = null;
    const l = this.activeLayer;
    const i = this.paint.hoverVertex;
    if (this.paint.tool !== 'navigate' && !l) return 'Add a layer to paint on';
    if (!l || i < 0) return '';
    const f = l.fields;
    if (f.density[i] <= 0.005) return `${l.locked ? 'locked · ' : ''}no hair here`;
    const cm = (f.length[i] * l.settings.lengthScale * 100).toFixed(1);
    return `${l.locked ? 'locked · ' : ''}density ${(f.density[i] * 100).toFixed(0)}% · ${cm} cm · lift ${(f.lift[i] * 100).toFixed(0)}% · bend ${f.curve[i].toFixed(0)}/m`;
  }

  reloadWarning(): string | null {
    return this.history.canUndo
      ? 'Changing the quality reloads the page. Your groom is saved, but its undo history will be lost.'
      : null;
  }

  /** Lines for the performance meter, short enough for its width here (the panel's). */
  hud(): string[] {
    const { strands, budget } = this.groom.strandTotals();
    const tool = TOOLS.find((x) => x.tool === this.paint.tool)?.label ?? '';
    const name = this.activeLayer?.name ?? '—';
    const lines = [
      `layer ${name.length > 30 ? `${name.slice(0, 29)}…` : name}`,
      `${tool}${this.paint.tool === 'navigate' ? '' : `   brush ${(this.paint.brush.radius * 100).toFixed(1)} cm`}${this.groom.busy ? '   growing…' : ''}`,
      `budget ${count(strands)} / ${count(budget)} strands${strands > budget ? ' (slow)' : ''}`,
    ];
    if (this.saveError) lines.push(this.saveError);
    return lines;
  }

  /** Debug handle (`__fursim.example.studio`) for automated checks. */
  get studio() {
    return {
      bust: this.bust,
      groom: this.groom,
      paint: this.paint,
      history: this.history,
      setTool: (t: Tool) => this.setTool(t),
      select: (id: string) => this.select(id),
      /** Paints through model-space points with a tool (`smoothing`: as with Shift held). */
      stroke: (tool: PaintTool, points: [number, number, number][], invert = false, smoothing = false) => {
        this.setTool(tool);
        this.paint.strokeThrough(
          points.map((p) => new THREE.Vector3(...p)),
          invert,
          smoothing,
        );
      },
      exportCurves: (what: CurveExport) => this.curvesText(what),
      isShapeTool,
    };
  }
}
