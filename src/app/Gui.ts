import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { Pane, type FolderApi, type TabPageApi } from 'tweakpane';

import type { HairSystem } from '../hair/HairSystem';
import type { HairParamsData } from '../hair/params';

type Container = Pane | FolderApi | TabPageApi;

export interface NumberSpec {
  min: number;
  max: number;
  step?: number;
  label?: string;
  digits?: number;
}

/** Tweakpane pane, plus the essentials plugin for its FPS graph. */
export class Gui {
  readonly pane: Pane;
  readonly fps: EssentialsPlugin.FpsGraphBladeApi;

  constructor() {
    this.pane = new Pane({ title: 'Hair & Fur Simulation', expanded: true });
    this.pane.registerPlugin(EssentialsPlugin);
    this.fps = this.pane.addBlade({
      view: 'fpsgraph',
      label: 'fps',
      rows: 2,
    }) as EssentialsPlugin.FpsGraphBladeApi;
  }

  folder(title: string, expanded = false, parent: Container = this.pane): FolderApi {
    return parent.addFolder({ title, expanded });
  }
}

/** Binds a numeric property. Decimal places scale with the slider's range unless `digits` is set. */
export function num<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  spec: NumberSpec,
  onChange: () => void,
) {
  const digits = spec.digits ?? (spec.max - spec.min <= 0.05 ? 5 : spec.max - spec.min <= 2 ? 3 : 2);
  return c
    .addBinding(obj, key, {
      min: spec.min,
      max: spec.max,
      step: spec.step,
      label: spec.label ?? key,
      format: (v: number) => v.toFixed(digits),
    })
    .on('change', onChange);
}

export function toggle<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  onChange: () => void,
  label?: string,
) {
  return c.addBinding(obj, key, { label: label ?? key }).on('change', onChange);
}

export function colorBinding<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  onChange: () => void,
  label?: string,
) {
  return c.addBinding(obj, key, { label: label ?? key, view: 'color' }).on('change', onChange);
}

export function vec3Binding<T extends object>(
  c: Container,
  obj: T,
  key: keyof T & string,
  range: number,
  onChange: () => void,
  label?: string,
) {
  return c
    .addBinding(obj, key, {
      label: label ?? key,
      x: { min: -range, max: range },
      y: { min: -range, max: range },
      z: { min: -range, max: range },
    })
    .on('change', onChange);
}

/** The end of every example's Debug folder: pause, single-step and reset the hair simulation. */
export function addSimulationControls(c: Container, hair: HairSystem, state: { paused: boolean }): void {
  toggle(c, state, 'paused', () => (hair.paused = state.paused), 'pause simulation');
  c.addButton({ title: 'Step one frame' }).on('click', () => (hair.stepOnce = true));
  c.addButton({ title: 'Reset simulation' }).on('click', () => hair.resetAll());
}

/** Adds Physics / Style / Shading folders bound to a hair group's params. */
export function addHairParamFolders(
  parent: Container,
  params: HairParamsData,
  onChange: () => void,
  expanded = false,
): void {
  const ph = params.physics;
  const st = params.style;
  const physics = parent.addFolder({ title: 'Physics', expanded });
  num(physics, ph, 'substeps', { min: 1, max: 12, step: 1 }, onChange);
  vec3Binding(physics, ph, 'gravity', 20, onChange);
  num(physics, ph, 'damping', { min: 0, max: 10, label: 'damping (1/s)' }, onChange);
  num(physics, ph, 'drag', { min: 0, max: 20, label: 'air drag (1/s)' }, onChange);
  num(physics, ph, 'followRoot', { min: 0, max: 1, label: 'follow root' }, onChange);
  num(physics, ph, 'dftlDamping', { min: 0, max: 1, label: 'FTL damping' }, onChange);
  num(physics, ph, 'maxVelocity', { min: 0.5, max: 50, label: 'max speed' }, onChange);
  const shape = physics.addFolder({ title: 'Shape / bending', expanded: true });
  num(shape, ph, 'globalStiffness', { min: 0, max: 1, label: 'style hold' }, onChange);
  num(shape, ph, 'globalTip', { min: 0, max: 1, label: 'hold at tip' }, onChange);
  num(shape, ph, 'globalCurve', { min: 0.1, max: 4, label: 'hold falloff' }, onChange);
  num(shape, ph, 'localStiffness', { min: 0, max: 1, label: 'bend stiffness' }, onChange);
  num(shape, ph, 'localTip', { min: 0, max: 1, label: 'bend at tip' }, onChange);
  const col = physics.addFolder({ title: 'Collision', expanded: false });
  num(col, ph, 'collisionMargin', { min: 0, max: 0.03, label: 'margin' }, onChange);
  num(col, ph, 'collisionFriction', { min: 0, max: 1, label: 'friction' }, onChange);
  num(col, ph, 'rootColliderRange', { min: 0, max: 1, label: 'root ignore range' }, onChange);
  num(col, ph, 'sdfRootRange', { min: 0, max: 1, label: 'body ignore range' }, onChange);
  num(col, ph, 'rootPlane', { min: 0, max: 1, label: 'skin plane' }, onChange);
  num(col, ph, 'rootPlaneRange', { min: 0, max: 1, label: 'skin plane range' }, onChange);
  toggle(col, st, 'collide', onChange, 'strand collision');
  const wind = physics.addFolder({ title: 'Wind', expanded: false });
  num(wind, ph, 'windStrength', { min: 0, max: 20, label: 'speed (m/s)' }, onChange);
  vec3Binding(wind, ph, 'windDirection', 1, onChange, 'direction');
  num(wind, ph, 'windTurbulence', { min: 0, max: 2, label: 'turbulence' }, onChange);
  num(wind, ph, 'windFrequency', { min: 0.05, max: 5, label: 'frequency' }, onChange);
  num(wind, ph, 'windGust', { min: 0, max: 2, label: 'gusts' }, onChange);

  const style = parent.addFolder({ title: 'Style', expanded: false });
  num(style, st, 'guideBlend', { min: 0, max: 1, label: 'guide blend' }, onChange);
  num(style, st, 'clump', { min: 0, max: 1 }, onChange);
  num(style, st, 'clumpShape', { min: 0.1, max: 5, label: 'clump shape' }, onChange);
  style.addBlade({ view: 'separator' });
  num(style, st, 'curlRadius', { min: 0, max: 0.03, label: 'curl radius' }, onChange);
  num(style, st, 'curlTurns', { min: 0, max: 40, label: 'curl turns' }, onChange);
  num(style, st, 'curlRamp', { min: 0.01, max: 1, label: 'curl ramp' }, onChange);
  num(style, st, 'frizz', { min: 0, max: 0.02 }, onChange);
  num(style, st, 'frizzFrequency', { min: 0.5, max: 30, label: 'frizz freq' }, onChange);
  style.addBlade({ view: 'separator' });
  num(style, st, 'rootWidth', { min: 0.00002, max: 0.003, label: 'root width', digits: 5 }, onChange);
  num(style, st, 'tipWidth', { min: 0, max: 0.003, label: 'tip width', digits: 5 }, onChange);
  num(style, st, 'taper', { min: 0.1, max: 5 }, onChange);
  num(style, st, 'minPixelWidth', { min: 0.25, max: 3, label: 'min px width' }, onChange);
  style.addBlade({ view: 'separator' });
  num(style, st, 'density', { min: 0.01, max: 1 }, onChange);
  toggle(style, st, 'lodEnabled', onChange, 'auto LOD');
  num(style, st, 'lodStrandsPerPixel', { min: 0.5, max: 40, label: 'LOD strands/px' }, onChange);
  num(style, st, 'lodWidthExponent', { min: 0, max: 1, label: 'LOD width comp.' }, onChange);

  const sh = params.shading;
  const shading = parent.addFolder({ title: 'Shading', expanded: false });
  colorBinding(shading, sh, 'rootColor', onChange, 'root color');
  colorBinding(shading, sh, 'tipColor', onChange, 'tip color');
  num(shading, sh, 'gradientStart', { min: 0, max: 1, label: 'gradient start' }, onChange);
  num(shading, sh, 'gradientEnd', { min: 0, max: 1, label: 'gradient end' }, onChange);
  num(shading, sh, 'textureInfluence', { min: 0, max: 1, label: 'texture color' }, onChange);
  num(shading, sh, 'hueJitter', { min: 0, max: 0.3, label: 'hue jitter' }, onChange);
  num(shading, sh, 'valueJitter', { min: 0, max: 0.6, label: 'value jitter' }, onChange);
  shading.addBlade({ view: 'separator' });
  num(shading, sh, 'specular', { min: 0, max: 2 }, onChange);
  num(shading, sh, 'roughness', { min: 0.05, max: 1 }, onChange);
  num(shading, sh, 'shift', { min: -0.2, max: 0.2, label: 'cuticle shift' }, onChange);
  num(shading, sh, 'backlit', { min: 0, max: 2, label: 'transmission' }, onChange);
  num(shading, sh, 'scatter', { min: 0, max: 2 }, onChange);
  shading.addBlade({ view: 'separator' });
  num(shading, sh, 'opacity', { min: 0, max: 1 }, onChange);
  num(shading, sh, 'tipFade', { min: 0, max: 1, label: 'tip fade' }, onChange);
  shading.addBlade({ view: 'separator' });
  num(shading, sh, 'selfShadowDensity', { min: 0, max: 5000, label: 'self-shadow' }, onChange);
  num(shading, sh, 'aoRoot', { min: 0, max: 1, label: 'root AO' }, onChange);
  num(shading, sh, 'aoRange', { min: 0.01, max: 1, label: 'AO range' }, onChange);
  num(shading, sh, 'ambient', { min: 0, max: 3 }, onChange);
}
