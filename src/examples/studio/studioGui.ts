import {
  FOLDERS,
  HAIR_CONTROLS,
  gravityStrength,
  type HairControl,
  type HairControlId,
  type Layout,
} from '../../app/Gui';
import { deepMerge, type HairParamsData } from '../../hair/params';
import type { Layer, LayerSettings } from './layers';
import { button, checkRow, el, rangeRow, type RangeSpec, type Synced } from './panelUi';

/**
 * Hair controls the Layer section above already has, so the advanced ones leave them out, plus ones that do nothing
 * here: no hair texture, and a drawn-strand fraction that would fight the painted density.
 */
const IN_GROOMING_PANEL: HairControlId[] = [
  'globalStiffness',
  'localStiffness',
  'damping',
  'curlRadius',
  'curlTurns',
  'frizz',
  'clump',
  'rootWidth',
  'specular',
  'rootColor',
  'tipColor',
  'textureInfluence',
  'density',
];

export interface LayerFolderHandlers {
  /** Settings that move hair to new places or change its resolution: regrow the layer. */
  regrow(layer: Layer): void;
  /** Hair params changed (physics, style, shading). */
  params(layer: Layer): void;
}

/** The groom's resolution, which regrows the layer (layer settings, not hair params). */
const RESOLUTION: { key: keyof LayerSettings; spec: RangeSpec; scale?: number }[] = [
  {
    key: 'guideSpacing',
    scale: 1000,
    spec: {
      label: 'guide spacing',
      min: 2,
      max: 20,
      step: 0.1,
      unit: 'mm',
      hint: 'Distance between simulated guide hairs: closer gives finer motion and shape, at a cost.',
    },
  },
  {
    key: 'guideParticles',
    spec: { label: 'guide points', min: 4, max: 32, step: 1, hint: 'Simulated points along each guide.' },
  },
  {
    key: 'strandPoints',
    spec: {
      label: 'strand points',
      min: 4,
      max: 48,
      step: 1,
      hint: 'Drawn points along each strand: more gives smoother curls.',
    },
  },
  {
    key: 'widthVariation',
    spec: {
      label: 'width variation',
      min: 0,
      max: 0.8,
      step: 0.01,
      hint: 'Random width difference between strands.',
    },
  },
];

/** A shared control's slider in this panel's terms: "margin (mm)" becomes label "margin", unit "mm". */
function rangeSpec(spec: {
  min: number;
  max: number;
  step?: number;
  digits?: number;
  label: string;
  hint: string;
}): RangeSpec {
  const m = /^(.*) \((.+)\)$/.exec(spec.label);
  const range = spec.max - spec.min;
  // The same precision as the Debug panel's sliders.
  const digits =
    spec.digits ??
    (spec.step !== undefined && spec.step >= 1
      ? 0
      : range <= 0.05
        ? 5
        : range <= 2
          ? 3
          : range >= 100
            ? 1
            : 2);
  return {
    label: m ? m[1] : spec.label,
    unit: m ? m[2] : undefined,
    min: spec.min,
    max: spec.max,
    step: spec.step ?? 10 ** -Math.min(digits, 3),
    hint: spec.hint,
  };
}

/**
 * The active layer's finer settings, in the grooming panel's Advanced section: the groom's resolution, then the
 * shared hair folders' controls (less those the Layer section has) in collapsible groups. Built once; they read and
 * write whichever layer is active.
 */
export class LayerFolders {
  private readonly controls: Synced[] = [];
  /** Each layer's hair params as it joined the groom, for Reset. */
  private readonly defaults = new Map<string, HairParamsData>();
  private layer: Layer | null = null;
  private readonly el: HTMLElement;
  private readonly on: LayerFolderHandlers;
  private readonly layerOf: (id: string) => Layer | undefined;

  constructor(parent: HTMLElement, layerOf: (id: string) => Layer | undefined, on: LayerFolderHandlers) {
    this.el = parent;
    this.layerOf = layerOf;
    this.on = on;

    const resolution = this.group('Resolution');
    for (const r of RESOLUTION) {
      const k = r.scale ?? 1;
      this.slider(
        resolution,
        r.spec,
        (l) => (l.settings[r.key] as number) * k,
        (l, x) => ((l.settings[r.key] as number) = x / k),
        'regrow',
      );
    }
    for (const [title, layout] of FOLDERS) this.build(this.group(title), layout);

    const reset = el('div', 'row');
    button(reset, 'Reset these hair settings', "Back to the layer's hair settings when it was made", () => {
      const l = this.layer;
      const d = l && this.defaults.get(l.id);
      if (!l || !d) return;
      deepMerge(
        l.params as unknown as Record<string, unknown>,
        structuredClone(d) as unknown as Record<string, unknown>,
      );
      this.on.params(l);
      this.refresh();
    });
    this.el.appendChild(reset);
  }

  /** A collapsible group, closed at first. */
  private group(title: string): HTMLElement {
    const g = el('div', 'group collapsed');
    const h = el('h4', '', title);
    h.onclick = () => g.classList.toggle('collapsed');
    g.appendChild(h);
    this.el.appendChild(g);
    return g;
  }

  private build(parent: HTMLElement, layout: Layout): void {
    for (const item of layout) {
      if (item === '---') parent.appendChild(el('div', 'gap'));
      else if (item.startsWith('# ')) parent.appendChild(el('div', 'subhead', item.slice(2)));
      else if (!IN_GROOMING_PANEL.includes(item as HairControlId))
        this.control(parent, item as HairControlId);
    }
  }

  private control(parent: HTMLElement, id: HairControlId): void {
    const ctl: HairControl = HAIR_CONTROLS[id];
    if (ctl.kind === 'gravity') {
      this.slider(
        parent,
        rangeSpec(ctl.spec),
        (l) => gravityStrength(l.params).v,
        (l, x) => (gravityStrength(l.params).v = x),
        'params',
      );
      return;
    }
    const of = (l: Layer) => l.params[ctl.section] as unknown as Record<string, number | boolean | string>;
    if (ctl.kind === 'num') {
      const k = ctl.spec.scale ?? 1;
      this.slider(
        parent,
        rangeSpec(ctl.spec),
        (l) => (of(l)[id] as number) * k,
        (l, x) => (of(l)[id] = x / k),
        'params',
      );
    } else if (ctl.kind === 'toggle') {
      this.controls.push(
        checkRow(
          parent,
          ctl.label,
          ctl.hint,
          () => (this.layer ? (of(this.layer)[id] as boolean) : false),
          (v) => this.edit((l) => (of(l)[id] = v), 'params'),
        ),
      );
    }
    // (Colours are in the Layer section.)
  }

  private slider(
    parent: HTMLElement,
    spec: RangeSpec,
    get: (l: Layer) => number,
    set: (l: Layer, x: number) => void,
    kind: 'params' | 'regrow',
  ): void {
    this.controls.push(
      rangeRow(
        parent,
        spec,
        () => (this.layer ? get(this.layer) : spec.min),
        (x) => this.edit((l) => set(l, x), kind),
      ),
    );
  }

  private edit(change: (l: Layer) => void, kind: 'params' | 'regrow'): void {
    const l = this.layer;
    if (!l) return;
    change(l);
    this.on[kind](l);
  }

  /** A layer joined the groom: remembers its hair settings, for Reset. */
  add(layer: Layer): void {
    if (!this.defaults.has(layer.id)) this.defaults.set(layer.id, structuredClone(layer.params));
  }

  remove(layer: Layer): void {
    this.defaults.delete(layer.id);
  }

  /** Shows the active layer's settings (none for null). */
  show(id: string | null): void {
    this.layer = (id && this.layerOf(id)) || null;
    this.el.hidden = !this.layer;
    this.refresh();
  }

  /** (The section follows the active layer, whose name the Layer section shows.) */
  setTitle(_layer: Layer): void {}

  /** Re-reads the values (after the Layer section, an undo or a load changed them). */
  refresh(_id?: string): void {
    if (this.layer) for (const c of this.controls) c.sync();
  }
}
