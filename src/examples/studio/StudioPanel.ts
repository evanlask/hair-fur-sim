import { IS_MAC } from '../../util/platform';
import type { BrushSettings, Tool } from './brushes';
import type { CurveExport } from './curveExport';
import type { Layer } from './layers';
import { LayerSection, type LayerSectionHandlers } from './layerSection';
import { rampLegend } from './overlay';
import { button, checkRow, el, rangeRow, section, type Synced } from './panelUi';

/** How the studio shows the groom (the View section). */
export interface DisplaySettings {
  showStrands: boolean;
  showGuides: boolean;
  showColliders: boolean;
  /** Simulate the hair (off: it holds its groomed shape). */
  physics: boolean;
  /** Pause the physics while a paint tool is active (the hair holds its groomed shape). */
  groomedWhilePainting: boolean;
  overlayOpacity: number;
}

export interface StudioPanelHandlers extends LayerSectionHandlers {
  setTool(tool: Tool): void;
  brushChanged(): void;
  displayChanged(): void;
  selectLayer(id: string): void;
  toggleVisible(id: string): void;
  toggleSolo(id: string): void;
  toggleLock(id: string): void;
  addLayer(): void;
  duplicateLayer(): void;
  deleteLayer(): void;
  moveLayer(delta: -1 | 1): void;
  /** Puts a layer at `index` in the list (dragged there). */
  reorderLayer(id: string, index: number): void;
  undo(): void;
  redo(): void;
  view(name: CameraView): void;
  /** Brings the head into view (F). */
  frame(): void;
  applyStarter(id: string): void;
  /** Removes every layer (undoable). */
  clearAll(): void;
  exportGroom(): void;
  exportCurves(what: CurveExport): void;
  importGroom(): void;
}

export type CameraView = 'front' | 'side' | 'back' | 'top';

/** ⌘ / Ctrl, as the platform names it. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Tools in panel order, with their keys and what they do. */
export const TOOLS: { tool: Tool; label: string; key: string; hint: string }[] = [
  {
    tool: 'navigate',
    label: 'Navigate',
    key: 'Q',
    hint: `Drag to turn the view, right-drag to pan, scroll to zoom. F fits the head in view; ${MOD}-drag the head to shake it.`,
  },
  {
    tool: 'density',
    label: 'Density',
    key: 'D',
    hint: `Paint where the layer grows hair. ${MOD} erases, Shift smooths.`,
  },
  {
    tool: 'length',
    label: 'Length',
    key: 'L',
    hint: `Paint the hair's length (set it below). ${MOD} shortens, Shift smooths.`,
  },
  {
    tool: 'comb',
    label: 'Comb',
    key: 'C',
    hint: 'Drag in the direction the hair should lie. Shift smooths.',
  },
  {
    tool: 'part',
    label: 'Part',
    key: 'P',
    hint: 'Drag along where the parting goes: the hair combs away from it on both sides (never mirrored).',
  },
  {
    tool: 'lift',
    label: 'Lift',
    key: 'R',
    hint: `How much hair stands up from the skin at the root. ${MOD} flattens, Shift smooths.`,
  },
  {
    tool: 'curve',
    label: 'Bend',
    key: 'B',
    hint: `How much hair bends as it grows, and how far it droops. ${MOD} straightens, Shift smooths.`,
  },
  {
    tool: 'wave',
    label: 'Wave',
    key: 'W',
    hint: `Paint the size of the hair's waves (their count is a layer setting). ${MOD} removes them.`,
  },
  {
    tool: 'smooth',
    label: 'Smooth',
    key: 'S',
    hint: 'Evens out the painted shape (or density) under the brush. Shift smooths with any tool.',
  },
  {
    tool: 'noise',
    label: 'Noise',
    key: 'N',
    hint: 'Makes the hair under the brush a little messy: uneven length, direction and lift. A bigger brush makes bigger patches. Shift smooths.',
  },
];

/** Brush value slider per tool: range and units of the value it paints (the brush keeps SI units). */
const VALUES: Partial<
  Record<
    Tool,
    {
      key: keyof BrushSettings['value'];
      label: string;
      min: number;
      max: number;
      step: number;
      scale: number;
      unit: string;
    }
  >
> = {
  density: { key: 'density', label: 'density', min: 0, max: 100, step: 1, scale: 100, unit: '%' },
  length: { key: 'length', label: 'length', min: 0.5, max: 60, step: 0.1, scale: 100, unit: 'cm' },
  lift: { key: 'lift', label: 'lift', min: 0, max: 100, step: 1, scale: 100, unit: '%' },
  curve: { key: 'curve', label: 'bend', min: 0, max: 40, step: 0.5, scale: 1, unit: '/m' },
  wave: { key: 'wave', label: 'wave size', min: 0, max: 20, step: 0.1, scale: 1000, unit: 'mm' },
  noise: { key: 'noise', label: 'amount', min: 0, max: 100, step: 1, scale: 100, unit: '%' },
};

const EYE =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
const LOCK =
  '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const SOLO =
  '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>';

/**
 * The studio's grooming panel (left): view, styles and files, tools, brush, the layer list, and the active layer's
 * settings (basic and advanced). The scene (lighting, rendering, motion) stays in the main (right) panel.
 */
export class StudioPanel {
  readonly el = el('aside');
  readonly layer: LayerSection;
  /** Holds the active layer's advanced settings (see LayerFolders). */
  readonly advanced: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly layerList = el('ul', 'layer-list');
  private readonly emptyHint = el('p', 'hint', 'No layers yet: add one, or apply a style below.');
  /** Notices, and the values under the brush while painting. */
  private readonly readout = el('p', 'readout');
  private readonly toolHint = el('p', 'hint');
  /** Hidden in Navigate (there's no brush). */
  private readonly brushSection: HTMLElement;
  private readonly legend = el('div', 'legend');
  private hudObserver: ResizeObserver | null = null;
  private unfit: (() => void) | null = null;
  private readonly status = el('span', 'status');
  private readonly brushControls: Synced[] = [];
  private readonly displayControls: Synced[] = [];
  private readonly rows: Record<'value' | 'gravity' | 'cut' | 'smooth', HTMLElement>;
  private readonly value: ReturnType<typeof rangeRow>;
  private valueSpec = VALUES.density;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly starter: HTMLSelectElement;

  private readonly on: StudioPanelHandlers;

  constructor(
    brush: BrushSettings,
    display: DisplaySettings,
    starters: { id: string; label: string }[],
    on: StudioPanelHandlers,
  ) {
    this.on = on;
    this.el.id = 'studio';

    // Undo / redo and the autosave state.
    const top = el('div', 'row');
    this.undoButton = button(top, 'Undo', '', () => on.undo());
    this.redoButton = button(top, 'Redo', '', () => on.redo());
    top.append(el('span', 'spacer'), this.status);
    this.el.appendChild(top);

    const tools = section(this.el, 'Tools');
    const grid = el('div', 'tool-grid');
    for (const t of TOOLS) {
      // Navigate gets a row of its own above the paint tools.
      const b = el('button', t.tool === 'navigate' ? 'wide' : '');
      b.append(el('span', 'name', t.label), el('kbd', '', t.key));
      b.title = t.hint;
      b.onclick = () => on.setTool(t.tool);
      this.toolButtons.set(t.tool, b);
      grid.appendChild(b);
    }
    // (The notices go with the tools: they show in Navigate too, which hides the Brush section.)
    tools.append(grid, this.toolHint, this.readout);

    const b = section(this.el, 'Brush');
    this.brushSection = b;
    const changed = () => on.brushChanged();
    const range = (...args: Parameters<typeof rangeRow>) => {
      const [parent, spec, get, set] = args;
      const c = rangeRow(parent, spec, get, (x) => {
        set(x);
        changed();
      });
      this.brushControls.push(c);
      return c;
    };
    const check = (label: string, hint: string, get: () => boolean, set: (v: boolean) => void) => {
      const c = checkRow(b, label, hint, get, (v) => {
        set(v);
        changed();
      });
      this.brushControls.push(c);
      return c.row;
    };
    range(
      b,
      { label: 'radius', min: 0.3, max: 8, step: 0.1, unit: 'cm', hint: 'Brush radius ([ and ] change it).' },
      () => brush.radius * 100,
      (x) => (brush.radius = x / 100),
    );
    // (Each tool keeps its own radius and strength: see PaintController.tool.)
    range(
      b,
      {
        label: 'strength',
        min: 5,
        max: 100,
        step: 1,
        unit: '%',
        hint: 'How strongly each dab paints (Shift+[ and ] change it; pen pressure scales it).',
      },
      () => brush.strength * 100,
      (x) => (brush.strength = x / 100),
    );
    this.value = range(
      b,
      {
        label: 'value',
        min: 0,
        max: 1,
        step: 0.01,
        hint: 'The value the brush paints. Hold I and click to pick it from the head.',
      },
      () => (this.valueSpec ? brush.value[this.valueSpec.key] * this.valueSpec.scale : 0),
      (x) => {
        if (this.valueSpec) brush.value[this.valueSpec.key] = x / this.valueSpec.scale;
      },
    );
    this.rows = {
      value: this.value.row,
      gravity: range(
        b,
        {
          label: 'droop',
          min: 0,
          max: 100,
          step: 1,
          unit: '%',
          hint: 'Where the bend takes the hair: 0 curls it along its comb direction (a curl-under), 100 down.',
        },
        () => brush.gravity * 100,
        (x) => (brush.gravity = x / 100),
      ).row,
      cut: check(
        'cut only',
        'Length only ever gets shorter, like scissors.',
        () => brush.cutOnly,
        (v) => (brush.cutOnly = v),
      ),
      smooth: check(
        'smooth density',
        'Even out where the hair grows instead of its shape.',
        () => brush.smooth === 'density',
        (v) => (brush.smooth = v ? 'density' : 'shape'),
      ),
    };
    b.appendChild(this.legend);
    check(
      'symmetry (X)',
      'Paint both sides of the face at once (partings are never mirrored).',
      () => brush.mirror,
      (v) => (brush.mirror = v),
    );

    const v = section(this.el, 'View');
    const views = el('div', 'row views');
    (['front', 'side', 'back', 'top'] as CameraView[]).forEach((name, i) => {
      const label = name[0].toUpperCase() + name.slice(1);
      button(views, label, `View from the ${name} (${i + 1})`, () => on.view(name));
    });
    button(views, 'Frame', 'Bring the head into view (F)', () => on.frame());
    v.appendChild(views);
    const shown = el('div', 'row');
    const displayCheck = (parent: HTMLElement, label: string, hint: string, key: keyof DisplaySettings) => {
      this.displayControls.push(
        checkRow(
          parent,
          label,
          hint,
          () => display[key] as boolean,
          (x) => {
            (display[key] as boolean) = x;
            on.displayChanged();
          },
        ),
      );
    };
    displayCheck(shown, 'hair (V)', 'Show the hair.', 'showStrands');
    displayCheck(
      shown,
      'guides',
      'Show the simulated guide hairs the drawn strands follow (always shown while combing or parting).',
      'showGuides',
    );
    displayCheck(shown, 'colliders', 'Show the shapes the hair collides with.', 'showColliders');
    v.appendChild(shown);
    const sim = el('div', 'row sim');
    displayCheck(sim, 'physics', 'Simulate the hair (off: it holds its groomed shape).', 'physics');
    displayCheck(
      sim,
      'pause while painting',
      'Paint tools show the hair in its groomed shape; Navigate lets the physics run.',
      'groomedWhilePainting',
    );
    v.appendChild(sim);
    this.displayControls.push(
      rangeRow(
        v,
        {
          label: 'map',
          min: 0,
          max: 100,
          step: 1,
          unit: '%',
          hint: 'Opacity of the painted map shown on the skin while painting.',
        },
        () => display.overlayOpacity * 100,
        (x) => {
          display.overlayOpacity = x / 100;
          on.displayChanged();
        },
      ),
    );

    const layers = section(this.el, 'Layers');
    layers.append(this.layerList, this.emptyHint);
    const actions = el('div', 'row');
    button(
      actions,
      '+ Add layer',
      'Add an empty layer to name and paint (Shift+A)',
      () => on.addLayer(),
      'grow',
    );
    button(actions, '⧉', 'Duplicate the layer', () => on.duplicateLayer());
    button(actions, '↑', 'Move up the list', () => on.moveLayer(-1));
    button(actions, '↓', 'Move down the list', () => on.moveLayer(1));
    button(actions, '✕', 'Delete the layer', () => on.deleteLayer());
    layers.appendChild(actions);

    this.layer = new LayerSection(this.el, on);
    // The active layer's finer settings (resolution, motion, strand shape, colour & shine, performance) go here.
    this.advanced = section(this.el, 'Advanced', true);
    this.advanced.classList.add('advanced');

    const style = section(this.el, 'Styles & files');
    const pick = el('div', 'row');
    this.starter = el('select', 'grow');
    this.starter.title = 'A look to start from';
    // Nothing chosen at first: a style showing there would read as the one on the head.
    this.starter.appendChild(new Option('Choose a style…', ''));
    for (const s of starters) this.starter.appendChild(new Option(s.label, s.id));
    pick.appendChild(this.starter);
    const apply = button(pick, 'Apply', 'Replace every layer with this style (undoable)', () =>
      on.applyStarter(this.starter.value),
    );
    apply.disabled = true;
    this.starter.onchange = () => (apply.disabled = !this.starter.value);
    style.appendChild(pick);
    const files = el('div', 'row');
    const exp = el('select', 'grow');
    exp.title = 'Download the groom';
    exp.append(
      new Option('Export…', ''),
      new Option('groom, to edit again (.json)', 'groom'),
      new Option('guide curves (USD .usda)', 'guides'),
      new Option('all strands (USD .usda)', 'strands'),
    );
    exp.onchange = () => {
      if (exp.value === 'groom') on.exportGroom();
      else if (exp.value) on.exportCurves(exp.value as CurveExport);
      exp.value = '';
    };
    files.appendChild(exp);
    button(files, 'Import', 'Load a groom exported from the studio (undoable)', () => on.importGroom());
    button(files, 'Clear all', 'Remove every layer (undoable)', () => on.clearAll());
    style.appendChild(files);
    // The view first (used all through a session, like a viewport toolbar), then in the order the work goes.
    this.el.append(top, v, style, tools, b, layers, this.layer.el, this.advanced);
    document.body.appendChild(this.el);

    // The panel reaches down to the performance meter, whose height follows what it shows.
    const hud = document.getElementById('hud');
    if (hud) {
      // The meter takes the panel's width under it.
      hud.classList.add('docked');
      const fit = () => {
        const gap =
          this.el.offsetTop - (document.getElementById('examples')?.getBoundingClientRect().bottom ?? 50);
        this.el.style.bottom = `${window.innerHeight - hud.getBoundingClientRect().top + gap}px`;
      };
      this.hudObserver = new ResizeObserver(fit);
      this.hudObserver.observe(hud);
      window.addEventListener('resize', fit);
      this.unfit = () => window.removeEventListener('resize', fit);
    }
  }

  /** Shows the controls of the current tool. */
  setTool(tool: Tool): void {
    for (const [t, b] of this.toolButtons) b.classList.toggle('active', t === tool);
    this.brushSection.hidden = tool === 'navigate';
    this.valueSpec = VALUES[tool];
    const v = this.valueSpec;
    this.rows.value.hidden = !v;
    if (v) {
      Object.assign(this.value.input, { min: `${v.min}`, max: `${v.max}`, step: `${v.step}` });
      this.value.name.textContent = v.label;
      this.value.unit = v.unit;
    }
    this.rows.gravity.hidden = tool !== 'curve';
    this.rows.cut.hidden = tool !== 'length';
    this.rows.smooth.hidden = tool !== 'smooth';
    const legend = rampLegend(tool);
    this.legend.hidden = !legend;
    if (legend) {
      this.legend.style.setProperty('--ramp', legend.css);
      this.legend.replaceChildren(el('span', '', legend.from), el('span', 'bar'), el('span', '', legend.to));
      this.legend.title = 'The map shown on the skin for this tool';
    }
    this.toolHint.textContent = TOOLS.find((t) => t.tool === tool)?.hint ?? '';
    this.refreshBrush();
  }

  /** Re-reads the brush settings (after hotkeys or the eyedropper changed them). */
  refreshBrush(): void {
    for (const c of this.brushControls) c.sync();
  }

  /** Re-reads the view settings (after a hotkey changed them). */
  refreshDisplay(): void {
    for (const c of this.displayControls) c.sync();
  }

  setReadout(text: string): void {
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }

  /** A short state by the undo buttons (autosave), with a tooltip; `warn` shows it as a problem. */
  setStatus(text: string, title: string, warn = false): void {
    this.status.textContent = text;
    this.status.title = title;
    this.status.classList.toggle('warn', warn);
  }

  /** Undo / redo: enabled when there's something to undo or redo, with what it is in the tooltip. */
  setHistory(undo: string | null, redo: string | null): void {
    this.undoButton.disabled = !undo;
    this.redoButton.disabled = !redo;
    this.undoButton.title = `Undo${undo ? ` ${undo}` : ''} (${MOD}Z)`;
    this.redoButton.title = `Redo${redo ? ` ${redo}` : ''} (⇧${MOD}Z)`;
  }

  /** Rebuilds the layer list (once a drag in it ends, if one is going on). */
  setLayers(
    layers: Layer[],
    activeId: string | null,
    solo: string | null,
    counts: Map<string, { guides: number; strands: number }>,
  ): void {
    if (this.dragged) {
      this.pendingList = () => this.setLayers(layers, activeId, solo, counts);
      return;
    }
    this.emptyHint.hidden = layers.length > 0;
    this.layerList.replaceChildren(
      ...layers.map((l, index) => {
        const li = el('li');
        this.draggable(li, l.id, index);
        li.classList.toggle('active', l.id === activeId);
        li.classList.toggle('hidden', !l.visible || (solo !== null && solo !== l.id));
        li.onclick = () => this.on.selectLayer(l.id);
        const icon = (html: string, cls: string, title: string, onClick: () => void) => {
          const b = el('button', `icon ${cls}`);
          b.innerHTML = html;
          b.title = title;
          b.onclick = (e) => {
            e.stopPropagation();
            onClick();
          };
          return b;
        };
        const eye = icon(EYE, l.visible ? '' : 'off', l.visible ? 'Hide' : 'Show', () =>
          this.on.toggleVisible(l.id),
        );
        const solo_ = icon(SOLO, solo === l.id ? 'on' : 'off', 'Solo: show only this layer', () =>
          this.on.toggleSolo(l.id),
        );
        const lock = icon(LOCK, l.locked ? 'on' : 'off', l.locked ? 'Unlock' : 'Lock (no painting)', () =>
          this.on.toggleLock(l.id),
        );
        const swatch = el('span', 'swatch');
        swatch.style.background = l.uiColor;
        const c = counts.get(l.id);
        const strands = c?.strands ?? 0;
        const meta = el(
          'span',
          'meta',
          strands ? `${(strands / 1000).toFixed(strands < 10000 ? 1 : 0)}k` : '—',
        );
        meta.title =
          c && strands
            ? `${c.guides.toLocaleString()} guides · ${strands.toLocaleString()} strands`
            : 'Nothing painted yet';
        const name = el('span', 'name', l.name);
        name.title = 'Double-click to rename';
        name.ondblclick = () => this.layer.focusName();
        li.append(eye, solo_, lock, swatch, name, meta);
        return li;
      }),
    );
  }

  /** The layer being dragged in the list, and the list to show when the drag ends (it changed meanwhile). */
  private dragged: { id: string; index: number } | null = null;
  private pendingList: (() => void) | null = null;

  /** Drag a row up or down the list to move its layer; a line shows where it will go. */
  private draggable(li: HTMLElement, id: string, index: number): void {
    li.draggable = true;
    const clear = () => li.classList.remove('drop-before', 'drop-after');
    /** Where a drop on this row puts the dragged layer (the row's upper half: above it), or null for nowhere new. */
    const target = (e: DragEvent): { to: number; before: boolean } | null => {
      const d = this.dragged;
      if (!d) return null;
      const r = li.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      const slot = before ? index : index + 1;
      const to = slot > d.index ? slot - 1 : slot;
      return to === d.index ? null : { to, before };
    };
    li.ondragstart = (e) => {
      this.dragged = { id, index };
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    };
    li.ondragover = (e) => {
      const t = target(e);
      clear();
      if (!t) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      li.classList.add(t.before ? 'drop-before' : 'drop-after');
    };
    li.ondragleave = clear;
    li.ondrop = (e) => {
      const t = target(e);
      clear();
      if (!t || !this.dragged) return;
      e.preventDefault();
      this.on.reorderLayer(this.dragged.id, t.to);
    };
    li.ondragend = () => {
      li.classList.remove('dragging');
      this.dragged = null;
      const pending = this.pendingList;
      this.pendingList = null;
      pending?.();
    };
  }

  dispose(): void {
    this.hudObserver?.disconnect();
    this.unfit?.();
    this.el.remove();
  }
}
