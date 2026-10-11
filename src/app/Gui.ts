import { Pane, type BladeApi, type FolderApi, type TabPageApi } from 'tweakpane';

import type { HairSystem } from '../hair/HairSystem';
import { deepMerge, hairWind, type HairParamsData } from '../hair/params';
import type { App } from './App';

type Container = Pane | FolderApi | TabPageApi;
/** Any input binding (they all refresh from their object). */
type Binding = BladeApi & { refresh(): void };

export interface NumberSpec {
  min: number;
  max: number;
  step?: number;
  label?: string;
  digits?: number;
  /** Display multiplier, e.g. 1000 to show metres as millimetres (min / max / step are in display units). */
  scale?: number;
  /** Tooltip shown when hovering the row. */
  hint?: string;
}

/** Tweakpane pane ("Debug", closed at first to leave the view free). Frame timing lives in the stats overlay. */
export class Gui {
  readonly pane: Pane;

  constructor() {
    this.pane = new Pane({ title: 'Debug', expanded: false });
  }

  folder(title: string, expanded = false, parent: Container = this.pane): FolderApi {
    return parent.addFolder({ title, expanded });
  }
}

/** Dropdown options ({ label: value }) sorted by label, A to Z (ignoring case). */
export function alphabetical<T>(options: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(options).sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
  );
}

/** Sets a row's hover tooltip. */
export function tip<T extends { element: HTMLElement }>(blade: T, hint?: string): T {
  if (hint) blade.element.title = hint;
  return blade;
}

/** A small section title inside a folder (a separator with text instead of a line). */
export function heading(c: Container, text: string): void {
  const sep = c.addBlade({ view: 'separator' });
  const label = document.createElement('div');
  label.textContent = text;
  sep.element.replaceChildren(label);
  sep.element.classList.add('gui-heading');
}

/**
 * Binds a numeric property as a slider. Decimal places follow the step and range unless `digits` is set (whole
 * steps show none); `scale` shows the value in other units (the object keeps its own).
 */
export function num<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  spec: NumberSpec,
  onChange: () => void,
) {
  const range = spec.max - spec.min;
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
  const s = spec.scale;
  const target = s
    ? {
        get v() {
          return (obj[key] as number) * s;
        },
        set v(x: number) {
          (obj[key] as number) = x / s;
        },
      }
    : obj;
  return tip(
    c
      .addBinding(target as Record<string, unknown>, s ? 'v' : key, {
        min: spec.min,
        max: spec.max,
        step: spec.step,
        label: spec.label ?? key,
        format: (v: number) => v.toFixed(digits),
      })
      .on('change', onChange),
    spec.hint,
  );
}

export function toggle<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  onChange: () => void,
  label?: string,
  hint?: string,
) {
  return tip(c.addBinding(obj, key, { label: label ?? key }).on('change', onChange), hint);
}

export function colorBinding<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  onChange: () => void,
  label?: string,
  hint?: string,
) {
  return tip(c.addBinding(obj, key, { label: label ?? key, view: 'color' }).on('change', onChange), hint);
}

/** Pause, slow motion, single-step and reset for the hair simulation (and the examples' animation). */
export function addSimulationControls(c: Container, app: App, hair: HairSystem): void {
  const state = { paused: false };
  num(
    c,
    app,
    'timeScale',
    {
      min: 0.05,
      max: 1,
      label: 'playback speed',
      hint: 'Slow motion for the simulation and animation (1 = real time). The camera stays real-time.',
    },
    () => {},
  );
  toggle(c, state, 'paused', () => (hair.paused = state.paused), 'pause simulation');
  c.addButton({ title: 'Step one frame' }).on('click', () => (hair.stepOnce = true));
  c.addButton({ title: 'Reset simulation' }).on('click', () => hair.resetAll());
}

/**
 * Wind, felt by every hair group (each group's `air drag` sets how much it reacts). A scene setting, so examples
 * add it at the top level, after their hair folders.
 */
export function addWindFolder(parent: Container): FolderApi {
  const w = hairWind.params;
  const sync = () => hairWind.sync();
  const wind = parent.addFolder({ title: 'Wind', expanded: false });
  toggle(wind, w, 'enabled', sync, 'enabled', 'Turn the wind on or off.');
  num(wind, w, 'strength', { min: 0, max: 12, label: 'speed (m/s)', hint: 'Wind speed.' }, sync);
  num(
    wind,
    w,
    'azimuth',
    {
      min: -180,
      max: 180,
      label: 'from azimuth (°)',
      hint: 'Direction the wind blows from, around the vertical axis (same angles as the lamps; 0 = from +Z).',
    },
    sync,
  );
  num(
    wind,
    w,
    'elevation',
    {
      min: -90,
      max: 90,
      label: 'from elevation (°)',
      hint: 'Height the wind blows from: positive blows down from above, negative is an updraft.',
    },
    sync,
  );
  num(
    wind,
    w,
    'turbulence',
    { min: 0, max: 2, hint: 'Random swirls on top of the steady wind, relative to its speed.' },
    sync,
  );
  num(
    wind,
    w,
    'frequency',
    {
      min: 0.05,
      max: 5,
      label: 'turbulence detail',
      hint: 'Size of the swirls: higher = smaller, busier eddies.',
    },
    sync,
  );
  num(
    wind,
    w,
    'gust',
    { min: 0, max: 2, label: 'gusts', hint: 'How strongly the wind speed pulses over time.' },
    sync,
  );
  num(
    wind,
    w,
    'gustPeriod',
    {
      min: 1,
      max: 15,
      label: 'gust period (s)',
      hint: 'Time between gusts. Gust fronts roll downwind at the wind speed, so longer periods mean wider waves across grass.',
    },
    sync,
  );
  return wind;
}

// ---------------------------------------------------------------------------------------------------------------
// Hair group controls

type Section = 'physics' | 'style' | 'shading';
export type HairControl =
  | { kind: 'num'; section: Section; spec: NumberSpec & { label: string; hint: string } }
  | { kind: 'toggle' | 'color'; section: Section; label: string; hint: string }
  | { kind: 'gravity'; spec: NumberSpec & { label: string; hint: string } };

const n = (section: Section, spec: NumberSpec & { label: string; hint: string }): HairControl => ({
  kind: 'num',
  section,
  spec,
});

/** Every hair parameter's control, keyed by parameter name. Basics and the folders share these. */
export const HAIR_CONTROLS = {
  // physics: shape
  globalStiffness: n('physics', {
    min: 0,
    max: 1,
    label: 'style hold',
    hint: 'Pull towards the groomed shape. Higher keeps the style; lower lets the hair hang and swing.',
  }),
  globalTip: n('physics', {
    min: 0,
    max: 1,
    label: 'hold at tip',
    hint: "Style hold at the tip, as a fraction of the root's.",
  }),
  globalCurve: n('physics', {
    min: 0.1,
    max: 4,
    label: 'hold falloff',
    hint: 'How the hold fades from root to tip: below 1 it drops quickly near the root, above 1 it stays strong and drops near the end.',
  }),
  globalRange: n('physics', {
    min: 0.05,
    max: 1,
    label: 'hold range',
    hint: 'Fraction of the strand (from the root) the hold fades over; beyond it only the tip hold is left.',
  }),
  localStiffness: n('physics', {
    min: 0,
    max: 1,
    label: 'bend stiffness',
    hint: 'Resistance to bending: keeps curls and bends in shape.',
  }),
  localTip: n('physics', {
    min: 0,
    max: 1,
    label: 'bend at tip',
    hint: "Bend stiffness at the tip, as a fraction of the root's.",
  }),
  // physics: motion
  damping: n('physics', {
    min: 0,
    max: 10,
    label: 'damping',
    hint: 'How quickly motion dies down (per second). Higher settles faster and bounces less.',
  }),
  drag: n('physics', {
    min: 0,
    max: 10,
    label: 'air drag',
    hint: 'Air resistance (per second): slows strands moving through the air and sets how strongly wind pushes them.',
  }),
  followRoot: n('physics', {
    min: 0,
    max: 1,
    label: 'move with body',
    hint: "Fraction of the body's motion the whole strand copies rigidly. 0 = full inertia (hair lags), 1 = moves like a helmet.",
  }),
  dftlDamping: n('physics', {
    min: 0,
    max: 1,
    label: 'stretch damping',
    hint: 'Removes the jitter that keeping strands at their length adds. About 0.9 looks natural; lower is livelier but jittery.',
  }),
  gravity: {
    kind: 'gravity',
    spec: { min: 0, max: 20, label: 'gravity (m/s²)', hint: 'Strength of gravity (Earth = 9.81).' },
  },
  // physics: collision
  collisionMargin: n('physics', {
    min: 0,
    max: 15,
    scale: 1000,
    label: 'margin (mm)',
    hint: 'Gap kept between the hair and the body.',
  }),
  collisionFriction: n('physics', {
    min: 0,
    max: 1,
    label: 'friction',
    hint: 'How much hair sticks instead of sliding when it touches the body.',
  }),
  collide: {
    kind: 'toggle',
    section: 'style',
    label: 'strand collision',
    hint: 'Also push the drawn strands (not just the simulated guides) out of the body. Fixes hair cutting through ears and shoulders; costs some speed.',
  },
  rootColliderRange: n('physics', {
    min: 0,
    max: 1,
    label: 'root collider skip',
    hint: 'Fraction of the strand, from the root, that ignores colliders the root is inside (so hair can grow out of them).',
  }),
  sdfRootRange: n('physics', {
    min: 0,
    max: 1,
    label: 'root body skip',
    hint: 'Fraction of the strand, from the root, that ignores the body shape, so fur can pass under skin folds (armpits).',
  }),
  rootPlane: n('physics', {
    min: 0,
    max: 1,
    label: 'keep off skin',
    hint: 'Keeps hair at least this fraction of its groomed height above the skin at its root, so fur does not lie flat.',
  }),
  rootPlaneRange: n('physics', {
    min: 0,
    max: 1,
    label: 'keep off skin range',
    hint: 'Fraction of the strand, from the root, that "keep off skin" applies to.',
  }),
  // physics: performance
  substeps: n('physics', {
    min: 1,
    max: 12,
    step: 1,
    label: 'substeps',
    hint: 'Solver steps per 1/60 s. More = stiffer, steadier hair but slower.',
  }),
  maxVelocity: n('physics', {
    min: 0.5,
    max: 30,
    label: 'max speed (m/s)',
    hint: 'Speed limit for strand points; keeps very fast motion stable.',
  }),
  // style
  clump: n('style', { min: 0, max: 1, label: 'clump', hint: 'How much strands gather into clumps.' }),
  clumpShape: n('style', {
    min: 0.1,
    max: 5,
    label: 'clump shape',
    hint: 'Where along the strand clumps pinch together: higher = only near the tips.',
  }),
  curlRadius: n('style', {
    min: 0,
    max: 30,
    scale: 1000,
    label: 'curl size (mm)',
    hint: 'Radius of the curls (0 = straight).',
  }),
  curlTurns: n('style', {
    min: 0,
    max: 20,
    label: 'curl turns',
    hint: 'Number of curl turns along a strand.',
  }),
  curlRamp: n('style', {
    min: 0.01,
    max: 1,
    label: 'curl fade-in',
    hint: 'Fraction of the strand over which the curls grow in from the root.',
  }),
  frizz: n('style', {
    min: 0,
    max: 8,
    scale: 1000,
    label: 'frizz (mm)',
    hint: 'Random flyaway offset of each strand.',
  }),
  frizzFrequency: n('style', {
    min: 0.5,
    max: 15,
    label: 'frizz detail',
    hint: 'How fine the frizz is: more waves along each strand.',
  }),
  rootWidth: n('style', {
    min: 0.02,
    max: 1.5,
    scale: 1000,
    digits: 3,
    label: 'root width (mm)',
    hint: 'Strand thickness at the root.',
  }),
  tipWidth: n('style', {
    min: 0,
    max: 1,
    scale: 1000,
    digits: 3,
    label: 'tip width (mm)',
    hint: 'Strand thickness at the tip.',
  }),
  taper: n('style', {
    min: 0.1,
    max: 5,
    label: 'taper',
    hint: 'How the width narrows towards the tip: higher stays thick for longer, then thins quickly.',
  }),
  guideBlend: n('style', {
    min: 0,
    max: 1,
    label: 'guide smoothing',
    hint: 'Drawn strands are interpolated from simulated guides: 0 = copy the nearest guide (clumpy), 1 = smooth blend of three.',
  }),
  density: n('style', { min: 0.01, max: 1, label: 'density', hint: 'Fraction of the strands drawn.' }),
  lodEnabled: {
    kind: 'toggle',
    section: 'style',
    label: 'auto LOD',
    hint: 'Automatically draw fewer, wider strands when the hair is small on screen.',
  },
  lodStrandsPerPixel: n('style', {
    min: 0.5,
    max: 20,
    label: 'LOD threshold',
    hint: 'On-screen strand density (strands per pixel) at which auto LOD starts thinning.',
  }),
  lodWidthExponent: n('style', {
    min: 0,
    max: 1,
    label: 'LOD thicken',
    hint: 'How much the remaining strands widen to make up for the removed ones (1 = keep the same coverage).',
  }),
  lodSegmentPx: n('style', {
    min: 0,
    max: 40,
    label: 'LOD segment (px)',
    hint: 'Faster: when strands are small on screen, draw every 2nd–4th point as long as each drawn segment stays at most this many pixels long. 0 = always draw every point.',
  }),
  lodSubpixelDensity: n('style', {
    min: 0.2,
    max: 1,
    label: 'sub-pixel density',
    hint: 'Faster: while strands are thinner than a pixel on screen, draw at least this fraction of them, wider to keep the same coverage. Up close every strand is drawn. 1 = off.',
  }),
  backCull: n('style', {
    min: 0,
    max: 1,
    label: 'skip far side',
    hint: 'Faster: skip strands on the side of the body facing away from the camera. Higher keeps more strands near the silhouette (raise it if fur pops at the edges); 0 = off.',
  }),
  minPixelWidth: n('style', {
    min: 0.25,
    max: 3,
    label: 'min width (px)',
    hint: 'Strands are drawn at least this wide on screen (avoids flicker); thinner hair is made transparent instead.',
  }),
  // shading
  rootColor: { kind: 'color', section: 'shading', label: 'root color', hint: 'Hair color at the root.' },
  tipColor: { kind: 'color', section: 'shading', label: 'tip color', hint: 'Hair color at the tip.' },
  gradientStart: n('shading', {
    min: 0,
    max: 1,
    label: 'color blend start',
    hint: 'Where along the strand (0 = root, 1 = tip) the root color starts blending into the tip color.',
  }),
  gradientEnd: n('shading', {
    min: 0,
    max: 1,
    label: 'color blend end',
    hint: 'Where along the strand the blend reaches the tip color.',
  }),
  textureInfluence: n('shading', {
    min: 0,
    max: 1,
    label: 'texture tint',
    hint: "How much the model's texture colors the hair.",
  }),
  hueJitter: n('shading', { min: 0, max: 0.3, label: 'hue variation', hint: 'Random hue shift per strand.' }),
  valueJitter: n('shading', {
    min: 0,
    max: 0.6,
    label: 'brightness variation',
    hint: 'Random brightness change per strand.',
  }),
  specular: n('shading', { min: 0, max: 2, label: 'shine', hint: 'Strength of the highlights.' }),
  roughness: n('shading', {
    min: 0.05,
    max: 1,
    label: 'roughness',
    hint: 'Highlight blur: low = sharp glossy highlights, high = soft ones.',
  }),
  shift: n('shading', {
    min: -0.2,
    max: 0.2,
    label: 'highlight shift',
    hint: 'Moves the highlights along the strand (the tilt of the hair cuticle).',
  }),
  backlit: n('shading', {
    min: 0,
    max: 2,
    label: 'backlight glow',
    hint: 'Light shining through the hair when it is lit from behind.',
  }),
  scatter: n('shading', {
    min: 0,
    max: 2,
    label: 'scatter',
    hint: 'Light bouncing around inside the hair volume (a softer, brighter look).',
  }),
  opacity: n('shading', { min: 0, max: 1, label: 'opacity', hint: 'Overall strand opacity.' }),
  tipFade: n('shading', {
    min: 0,
    max: 1,
    label: 'tip fade',
    hint: 'Fraction of the strand at the tip that fades out.',
  }),
  selfShadowDensity: n('shading', {
    min: 0,
    max: 1000,
    label: 'self-shadow',
    hint: 'How strongly the hair shadows itself: deep layers get darker.',
  }),
  aoRoot: n('shading', {
    min: 0,
    max: 1,
    label: 'root darkening',
    hint: 'Darkens the hair near the roots, where less light gets in.',
  }),
  aoRange: n('shading', {
    min: 0.01,
    max: 1,
    label: 'darkening length',
    hint: 'Fraction of the strand the root darkening covers.',
  }),
  ambient: n('shading', {
    min: 0,
    max: 3,
    label: 'ambient',
    hint: 'Brightness of the environment light on the hair.',
  }),
} satisfies Record<string, HairControl>;

export type HairControlId = keyof typeof HAIR_CONTROLS;
/** Per-group changes to the shared hair panel, for grooms that aren't hair (grass). */
export interface HairPanelOptions {
  /**
   * Slider ranges that replace the shared ones, for grooms on a different scale from hair (grass blades are
   * millimetres wide). Everything else keeps the shared ranges, so hair panels stay comparable.
   */
  ranges?: Partial<Record<HairControlId, Pick<NumberSpec, 'min' | 'max'>>>;
  /** Controls left out because they do nothing for this groom (no body, no curls). */
  hide?: HairControlId[];
}
export type Layout = (HairControlId | '---' | `# ${string}`)[];

const BASICS: Layout = [
  'globalStiffness',
  'localStiffness',
  'damping',
  'gravity',
  'curlRadius',
  'frizz',
  'clump',
  'rootWidth',
  'specular',
];

/** The hair folders and what they hold, in order ('---' a gap, '# x' a heading). */
export const FOLDERS: [string, Layout][] = [
  [
    'Motion',
    [
      'globalStiffness',
      'globalTip',
      'globalCurve',
      'globalRange',
      '---',
      'localStiffness',
      'localTip',
      '---',
      'damping',
      'drag',
      'followRoot',
      'dftlDamping',
      'gravity',
      '# Collision',
      'collisionMargin',
      'collisionFriction',
      'collide',
      'rootColliderRange',
      'sdfRootRange',
      'rootPlane',
      'rootPlaneRange',
    ],
  ],
  [
    'Strand shape',
    [
      'clump',
      'clumpShape',
      '---',
      'curlRadius',
      'curlTurns',
      'curlRamp',
      'frizz',
      'frizzFrequency',
      '---',
      'rootWidth',
      'tipWidth',
      'taper',
    ],
  ],
  [
    'Color & shine',
    [
      'rootColor',
      'tipColor',
      'gradientStart',
      'gradientEnd',
      'textureInfluence',
      'hueJitter',
      'valueJitter',
      '---',
      'specular',
      'roughness',
      'shift',
      'backlit',
      'scatter',
      '---',
      'opacity',
      'tipFade',
      '---',
      'selfShadowDensity',
      'aoRoot',
      'aoRange',
      'ambient',
    ],
  ],
  [
    'Performance',
    [
      'substeps',
      'maxVelocity',
      'guideBlend',
      'density',
      'lodEnabled',
      'lodStrandsPerPixel',
      'lodWidthExponent',
      'lodSegmentPx',
      'lodSubpixelDensity',
      'backCull',
      'minPixelWidth',
    ],
  ],
];

/** Gravity as one strength slider; the direction is kept (straight down if it was zero). */
export function gravityStrength(params: HairParamsData) {
  const g = params.physics.gravity;
  return {
    get v() {
      return Math.hypot(g.x, g.y, g.z);
    },
    set v(m: number) {
      const len = Math.hypot(g.x, g.y, g.z);
      if (len < 1e-6) Object.assign(g, { x: 0, y: -m, z: 0 });
      else Object.assign(g, { x: (g.x * m) / len, y: (g.y * m) / len, z: (g.z * m) / len });
    },
  };
}

/**
 * The controls of one hair group. A parameter can appear twice (Basics and its folder): the copies stay in sync.
 */
class HairControls {
  private readonly bindings = new Map<HairControlId, Binding[]>();
  private readonly defaults: HairParamsData;
  private syncing = false;

  private readonly params: HairParamsData;
  private readonly onChange: () => void;
  private readonly options: HairPanelOptions;

  constructor(params: HairParamsData, onChange: () => void, options: HairPanelOptions) {
    this.params = params;
    this.onChange = onChange;
    this.options = options;
    this.defaults = structuredClone(params);
  }

  build(c: Container, layout: Layout): void {
    for (const item of layout) {
      if (item === '---') c.addBlade({ view: 'separator' });
      else if (item.startsWith('# ')) heading(c, item.slice(2));
      else if (!this.options.hide?.includes(item as HairControlId)) this.add(c, item as HairControlId);
    }
  }

  private add(c: Container, id: HairControlId): void {
    const ctl: HairControl = HAIR_CONTROLS[id];
    const changed = () => this.changed(id);
    let b: Binding;
    const range = this.options.ranges?.[id];
    if (ctl.kind === 'gravity') {
      b = num(c, gravityStrength(this.params), 'v', { ...ctl.spec, ...range }, changed);
    } else {
      const obj = this.params[ctl.section] as unknown as Record<string, unknown>;
      if (ctl.kind === 'num') b = num(c, obj, id, { ...ctl.spec, ...range }, changed);
      else if (ctl.kind === 'toggle') b = toggle(c, obj, id, changed, ctl.label, ctl.hint);
      else b = colorBinding(c, obj, id, changed, ctl.label, ctl.hint);
    }
    const list = this.bindings.get(id) ?? [];
    list.push(b);
    this.bindings.set(id, list);
  }

  private changed(id: HairControlId): void {
    if (this.syncing) return;
    this.refresh(this.bindings.get(id) ?? []);
    this.onChange();
  }

  private refresh(bindings: Iterable<Binding>): void {
    this.syncing = true;
    for (const b of bindings) b.refresh();
    this.syncing = false;
  }

  /** Back to the values the group started with. */
  reset(): void {
    deepMerge(
      this.params as unknown as Record<string, unknown>,
      structuredClone(this.defaults) as unknown as Record<string, unknown>,
    );
    this.refresh([...this.bindings.values()].flat());
    this.onChange();
  }
}

const controlsByParams = new WeakMap<HairParamsData, HairControls>();

/** Drops the cached controls of a params object whose panel was disposed, so a new panel starts clean. */
export function forgetHairControls(params: HairParamsData): void {
  controlsByParams.delete(params);
}

function controlsFor(params: HairParamsData, onChange: () => void, options: HairPanelOptions): HairControls {
  let ctl = controlsByParams.get(params);
  if (!ctl) {
    ctl = new HairControls(params, onChange, options);
    controlsByParams.set(params, ctl);
  }
  return ctl;
}

/** The most useful sliders of a hair group, shown right in its folder (they also appear in the folders below). */
export function addHairBasics(
  c: Container,
  params: HairParamsData,
  onChange: () => void,
  options: HairPanelOptions = {},
): void {
  heading(c, 'Basics');
  controlsFor(params, onChange, options).build(c, BASICS);
}

/** Motion / Strand shape / Color & shine / Performance folders for a hair group, and a reset button. */
export function addHairFolders(
  c: Container,
  params: HairParamsData,
  onChange: () => void,
  options: HairPanelOptions = {},
): void {
  const ctl = controlsFor(params, onChange, options);
  for (const [title, layout] of FOLDERS) ctl.build(c.addFolder({ title, expanded: false }), layout);
  c.addButton({ title: 'Reset these hair settings' }).on('click', () => ctl.reset());
}
