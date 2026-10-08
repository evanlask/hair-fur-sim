import type { ShadingParams } from './params';

/** A hair colour look: sRGB colours plus the shading terms that change with pigmentation. */
interface HairColorPreset {
  rootColor: string;
  tipColor: string;
  hueJitter: number;
  valueJitter: number;
  specular: number;
  roughness: number;
  /** Transmission: lightly pigmented hair glows when backlit. */
  backlit: number;
  scatter: number;
  /** Self-shadow density relative to the example's default (light hair absorbs less). */
  shadowScale: number;
}

/** Selectable hair colours; 'brown' restores the example's own (brown) defaults. */
export const HAIR_COLORS = ['brown', 'black', 'blonde', 'red', 'gray', 'pink', 'blue'] as const;
export type HairColorName = (typeof HAIR_COLORS)[number];

const PRESETS: Record<Exclude<HairColorName, 'brown'>, HairColorPreset> = {
  black: {
    rootColor: '#080707',
    tipColor: '#1f1b19',
    hueJitter: 0.01,
    valueJitter: 0.25,
    specular: 0.85,
    roughness: 0.26,
    backlit: 0.15,
    scatter: 0.15,
    shadowScale: 1,
  },
  blonde: {
    rootColor: '#6b4f2c',
    tipColor: '#e3c58a',
    hueJitter: 0.025,
    valueJitter: 0.18,
    specular: 0.45,
    roughness: 0.36,
    backlit: 1.3,
    scatter: 1.2,
    shadowScale: 0.5,
  },
  red: {
    rootColor: '#5c210c',
    tipColor: '#c4622d',
    hueJitter: 0.03,
    valueJitter: 0.2,
    specular: 0.5,
    roughness: 0.33,
    backlit: 1.0,
    scatter: 0.95,
    shadowScale: 0.7,
  },
  // Grey hair is a mix of white and pigmented strands: strong per-strand value variation, no hue.
  gray: {
    rootColor: '#505358',
    tipColor: '#d2d5da',
    hueJitter: 0,
    valueJitter: 0.55,
    specular: 0.55,
    roughness: 0.33,
    backlit: 0.8,
    scatter: 0.8,
    shadowScale: 0.65,
  },
  pink: {
    rootColor: '#7a1f4f',
    tipColor: '#ff86c2',
    hueJitter: 0.02,
    valueJitter: 0.15,
    specular: 0.5,
    roughness: 0.3,
    backlit: 1.0,
    scatter: 1.0,
    shadowScale: 0.7,
  },
  blue: {
    rootColor: '#0e1c4d',
    tipColor: '#3d7dff',
    hueJitter: 0.02,
    valueJitter: 0.15,
    specular: 0.55,
    roughness: 0.3,
    backlit: 0.9,
    scatter: 0.9,
    shadowScale: 0.8,
  },
};

/** Applies a colour look to `shading`; `defaults` is the example's original shading (for 'brown' and relative terms). */
export function applyHairColor(shading: ShadingParams, defaults: ShadingParams, name: HairColorName): void {
  if (name === 'brown') {
    const {
      rootColor,
      tipColor,
      hueJitter,
      valueJitter,
      specular,
      roughness,
      backlit,
      scatter,
      selfShadowDensity,
    } = defaults;
    Object.assign(shading, {
      rootColor,
      tipColor,
      hueJitter,
      valueJitter,
      specular,
      roughness,
      backlit,
      scatter,
      selfShadowDensity,
    });
    return;
  }
  const { shadowScale, ...look } = PRESETS[name];
  Object.assign(shading, look);
  shading.selfShadowDensity = defaults.selfShadowDensity * shadowScale;
}

/** Dropdown options for Tweakpane ({ label: value }). */
export const hairColorOptions = (): Record<string, HairColorName> =>
  Object.fromEntries(HAIR_COLORS.map((c) => [c, c])) as Record<string, HairColorName>;
