import { HAIR_COLORS, applyHairColor, type HairColorName } from '../../hair/colorPresets';
import { mergeHairParams, type ShadingParams } from '../../hair/params';
import { FLOW_PRESETS, type FlowPreset } from './headSpace';
import { NEW_LAYER, type Layer } from './layers';
import { button, colorInput, el, rangeRow, section, type RangeSpec, type Synced } from './panelUi';

export type LayerAction = 'fill' | 'fillValue' | 'clear' | 'mirror' | 'mirrorRL' | 'flow';

export interface LayerSectionHandlers {
  /** Hair params changed (colour, strand look, motion). */
  params(layer: Layer): void;
  /** Strands per cm² or length variation changed: regrows the layer. */
  regrow(layer: Layer): void;
  /** Length scale or wave count changed: reshapes the layer. */
  reshape(layer: Layer): void;
  /** Name or list colour changed. */
  renamed(layer: Layer): void;
  action(layer: Layer, action: LayerAction, preset?: FlowPreset): void;
}

/** A new layer's shading: what the 'brown' colour preset restores. */
const BASE_SHADING: ShadingParams = mergeHairParams(structuredClone(NEW_LAYER.params)).shading;

/** Preset name of a layer's current colours, if they are one. */
function presetOf(layer: Layer): HairColorName | null {
  const sh = layer.params.shading;
  for (const name of HAIR_COLORS) {
    const s = { ...BASE_SHADING };
    applyHairColor(s, BASE_SHADING, name);
    if (s.rootColor === sh.rootColor && s.tipColor === sh.tipColor) return name;
  }
  return null;
}

/**
 * The active layer in the left panel: its name and list colour, the hair colour (presets, root and tip), the main
 * strand-shape, motion and shine sliders, and whole-layer actions. The rest of its settings are in the panel's
 * Advanced section (see LayerFolders).
 */
export class LayerSection {
  readonly el: HTMLElement;
  private layer: Layer | null = null;
  private readonly controls: Synced[] = [];
  private readonly nameInput = el('input', 'name');
  private readonly swatches: { name: HairColorName; el: HTMLButtonElement }[] = [];
  private readonly on: LayerSectionHandlers;

  constructor(parent: HTMLElement, on: LayerSectionHandlers) {
    this.on = on;
    this.el = section(parent, 'Layer');
    const top = el('div', 'row');
    this.nameInput.type = 'text';
    this.nameInput.title = 'Layer name (double-click a layer in the list to rename it)';
    this.nameInput.oninput = () => this.edit((l) => (l.name = this.nameInput.value), 'renamed');
    // Enter or Esc leaves the field (the name is already saved), so the tool keys work again.
    this.nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') this.nameInput.blur();
    };
    top.appendChild(this.nameInput);
    this.controls.push(
      colorInput(
        top,
        'Display colour: the layer in the list and its painted density on the skin (not the hair)',
        () => this.layer?.uiColor ?? '#ffffff',
        (hex) => this.edit((l) => (l.uiColor = hex), 'renamed'),
      ),
    );
    this.el.appendChild(top);

    // Hair colour: presets, then the root and tip colours themselves.
    const presets = el('div', 'swatches');
    for (const name of HAIR_COLORS) {
      const b = el('button', 'swatch');
      b.title = `${name} hair`;
      b.onclick = () => this.edit((l) => applyHairColor(l.params.shading, BASE_SHADING, name), 'params');
      presets.appendChild(b);
      this.swatches.push({ name, el: b });
    }
    this.el.appendChild(presets);
    const colors = el('div', 'row colors');
    colors.append(el('span', 'name', 'root color'));
    this.controls.push(
      colorInput(
        colors,
        'Hair color at the root',
        () => this.layer?.params.shading.rootColor ?? '#000000',
        (hex) => this.edit((l) => (l.params.shading.rootColor = hex), 'params'),
      ),
    );
    colors.append(el('span', 'name', 'tip color'));
    this.controls.push(
      colorInput(
        colors,
        'Hair color at the tip',
        () => this.layer?.params.shading.tipColor ?? '#000000',
        (hex) => this.edit((l) => (l.params.shading.tipColor = hex), 'params'),
      ),
    );
    this.el.appendChild(colors);

    // The sliders people reach for most; the rest are in the Advanced section.
    const p = () => this.layer!.params;
    const s = () => this.layer!.settings;
    this.slider(
      {
        label: 'density',
        min: 10,
        max: 300,
        step: 1,
        unit: '/cm²',
        hint: 'Strands per square centimetre where the density map is 100% (regrows the layer).',
      },
      () => s().hairPerCm2,
      (x) => (s().hairPerCm2 = x),
      'regrow',
    );
    this.slider(
      { label: 'length ×', min: 0.2, max: 3, step: 0.01, hint: 'Scales the painted lengths.' },
      () => s().lengthScale,
      (x) => (s().lengthScale = x),
      'reshape',
    );
    this.slider(
      {
        label: 'length variation',
        min: 0,
        max: 0.9,
        step: 0.01,
        hint: 'Random shortening of individual strands, for natural, uneven ends (regrows the layer).',
      },
      () => s().lengthVariation,
      (x) => (s().lengthVariation = x),
      'regrow',
    );
    this.slider(
      {
        label: 'waves',
        min: 0,
        max: 8,
        step: 0.1,
        hint: 'Waves along each hair (paint their size with the Wave tool).',
      },
      () => s().waveCount,
      (x) => (s().waveCount = x),
      'reshape',
    );
    this.slider(
      {
        label: 'curl radius',
        min: 0,
        max: 30,
        step: 0.1,
        unit: 'mm',
        hint: 'Radius of each strand’s curls (0 = straight).',
      },
      () => p().style.curlRadius * 1000,
      (x) => (p().style.curlRadius = x / 1000),
      'params',
    );
    this.slider(
      { label: 'curl turns', min: 0, max: 20, step: 0.1, hint: 'Curl turns along each strand.' },
      () => p().style.curlTurns,
      (x) => (p().style.curlTurns = x),
      'params',
    );
    this.slider(
      {
        label: 'frizz',
        min: 0,
        max: 8,
        step: 0.05,
        unit: 'mm',
        hint: 'Random flyaway offset of each strand, growing towards the tip.',
      },
      () => p().style.frizz * 1000,
      (x) => (p().style.frizz = x / 1000),
      'params',
    );
    this.slider(
      { label: 'clump', min: 0, max: 1, step: 0.01, hint: 'How much strands gather round their guide.' },
      () => p().style.clump,
      (x) => (p().style.clump = x),
      'params',
    );
    this.slider(
      { label: 'width', min: 0.02, max: 1.5, step: 0.01, unit: 'mm', hint: 'Strand width at the root.' },
      () => p().style.rootWidth * 1000,
      (x) => (p().style.rootWidth = x / 1000),
      'params',
    );
    this.slider(
      { label: 'shine', min: 0, max: 2, step: 0.01, hint: 'Strength of the highlights (specular).' },
      () => p().shading.specular,
      (x) => (p().shading.specular = x),
      'params',
    );
    this.slider(
      {
        label: 'style hold',
        min: 0,
        max: 1,
        step: 0.01,
        hint: 'Global shape stiffness: pull towards the groomed shape. Higher keeps the style, lower lets the hair hang and swing.',
      },
      () => p().physics.globalStiffness,
      (x) => (p().physics.globalStiffness = x),
      'params',
    );
    this.slider(
      {
        label: 'bend stiffness',
        min: 0,
        max: 1,
        step: 0.01,
        hint: 'Local stiffness, resistance to bending: keeps curls and bends in shape.',
      },
      () => p().physics.localStiffness,
      (x) => (p().physics.localStiffness = x),
      'params',
    );
    this.slider(
      {
        label: 'damping',
        min: 0,
        max: 10,
        step: 0.05,
        hint: 'How quickly motion dies down (per second). Higher settles faster and bounces less.',
      },
      () => p().physics.damping,
      (x) => (p().physics.damping = x),
      'params',
    );

    const fills = el('div', 'row actions');
    button(fills, 'Fill scalp', 'Paint hair over the whole scalp, down to the hairline.', () =>
      this.act('fill'),
    );
    button(
      fills,
      'Fill value',
      'Set the whole layer to the brush value of the current tool (density, length, lift, bend or wave).',
      () => this.act('fillValue'),
    );
    button(fills, 'Clear', 'Remove all of this layer’s hair.', () => this.act('clear'));
    this.el.appendChild(fills);
    const mirror = el('div', 'row actions');
    button(mirror, 'Mirror left → right', 'Copy the face’s left side (its own left) onto its right.', () =>
      this.act('mirror'),
    );
    button(mirror, 'right → left', 'Copy the face’s right side onto its left.', () => this.act('mirrorRL'));
    this.el.appendChild(mirror);
    const combRow = el('div', 'row');
    const comb = el('select', 'grow');
    comb.title = 'Comb the whole layer in a preset direction';
    comb.appendChild(new Option('Comb the whole layer…', ''));
    for (const [k, label] of Object.entries(FLOW_PRESETS)) comb.appendChild(new Option(label, k));
    comb.onchange = () => {
      if (comb.value) this.act('flow', comb.value as FlowPreset);
      comb.value = '';
    };
    combRow.appendChild(comb);
    this.el.appendChild(combRow);
  }

  /** Puts the cursor in the name field, to rename the layer. */
  focusName(): void {
    this.nameInput.focus();
    this.nameInput.select();
  }

  private slider(
    spec: RangeSpec,
    get: () => number,
    set: (x: number) => void,
    kind: 'params' | 'regrow' | 'reshape',
  ): void {
    this.controls.push(
      rangeRow(
        this.el,
        spec,
        () => (this.layer ? get() : 0),
        (x) => this.edit(() => set(x), kind),
      ),
    );
  }

  private edit(change: (l: Layer) => void, kind: 'params' | 'regrow' | 'reshape' | 'renamed'): void {
    const l = this.layer;
    if (!l) return;
    change(l);
    this.on[kind](l);
    if (kind === 'params') this.refresh();
  }

  private act(action: LayerAction, preset?: FlowPreset): void {
    if (this.layer) this.on.action(this.layer, action, preset);
  }

  /** Shows a layer's settings (none: the section hides). */
  setLayer(layer: Layer | null): void {
    this.layer = layer;
    this.el.hidden = !layer;
    this.refresh();
  }

  /** Re-reads the layer's values (after the Advanced settings or an undo changed them). */
  refresh(): void {
    const l = this.layer;
    if (!l) return;
    if (document.activeElement !== this.nameInput) this.nameInput.value = l.name;
    for (const c of this.controls) c.sync();
    const current = presetOf(l);
    const base = BASE_SHADING;
    for (const { name, el: b } of this.swatches) {
      const s = { ...base };
      applyHairColor(s, base, name);
      b.style.background = `linear-gradient(135deg, ${s.rootColor} 15%, ${s.tipColor} 85%)`;
      b.classList.toggle('active', name === current);
    }
  }
}
