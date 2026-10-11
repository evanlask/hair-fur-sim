import { createFields, type PaintedFields, type PaintedLayer } from '../../hair/groom/styles/paintedStyle';
import type { GroomGroupSpec, GrowthMesh } from '../../hair/groom/types';
import { mergeHairParams, type DeepPartial, type HairParamsData } from '../../hair/params';
import type { HeadFrame } from './heads';
import { applyFlowPreset } from './headSpace';
import type { PaintMesh } from './paintMesh';

/** The layer templates the starter styles are made of. */
export type LayerTemplateName = 'scalp' | 'long' | 'short' | 'fringe' | 'beard' | 'brows';

/** Groom settings of a layer (the painted maps hold everything that varies over the surface). */
export interface LayerSettings {
  /** Strands per cm² where the density is 1 (scalp hair is ~150 per cm²; fewer, wider strands look the same). */
  hairPerCm2: number;
  /** Distance between neighbouring guides (m). */
  guideSpacing: number;
  /** Simulated points per guide. */
  guideParticles: number;
  /** Drawn points per strand. */
  strandPoints: number;
  /** Multiplies the painted lengths. */
  lengthScale: number;
  /** Random shortening of individual strands (0..1). */
  lengthVariation: number;
  /** Random strand width difference (±). */
  widthVariation: number;
  /** Waves along a guide (their size is painted). */
  waveCount: number;
  /** Random stream of the layer's roots, so its hair keeps its layout when other layers change. */
  seed: number;
  /**
   * Where the layer's hair is gathered, as by a hair tie (a point on the skin, model units): it grows over the skin
   * to there (see gatherSteer). Unset for loose hair.
   */
  gather?: [number, number, number];
}

export interface Layer {
  /** Stable id: the hair group's name. */
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Swatch and overlay colour. */
  uiColor: string;
  settings: LayerSettings;
  params: HairParamsData;
  fields: PaintedFields;
}

/** What a layer is made with: its list colour, groom settings and hair params. */
export interface LayerTemplate {
  uiColor: string;
  settings: Omit<LayerSettings, 'seed'>;
  params: DeepPartial<HairParamsData>;
}

const SHADING = {
  rootColor: '#2a1a10',
  tipColor: '#8b6440',
  gradientStart: 0.05,
  gradientEnd: 1,
  textureInfluence: 0,
  hueJitter: 0.03,
  valueJitter: 0.22,
  specular: 0.55,
  roughness: 0.32,
  shift: 0.04,
  backlit: 0.7,
  scatter: 0.65,
  selfShadowDensity: 380,
  aoRoot: 0.3,
  aoRange: 0.3,
  tipFade: 0.2,
};
const STRAND = {
  rootWidth: 0.00015,
  tipWidth: 0.00005,
  taper: 1.3,
  clump: 0.25,
  clumpShape: 1.4,
  frizz: 0.0004,
  frizzFrequency: 6,
  lodStrandsPerPixel: 8,
};

/** The starter styles' layers are made from these, with the physics of Wayne's two groups for scalp and long hair. */
export const LAYER_TEMPLATES: Record<LayerTemplateName, LayerTemplate> = {
  scalp: {
    uiColor: '#f0b35a',
    settings: {
      hairPerCm2: 110,
      guideSpacing: 0.0055,
      guideParticles: 12,
      strandPoints: 12,
      lengthScale: 1,
      lengthVariation: 0.3,
      widthVariation: 0.3,
      waveCount: 1.5,
    },
    params: {
      physics: {
        globalStiffness: 0.32,
        globalTip: 0.5,
        localStiffness: 0.8,
        localTip: 0.65,
        damping: 9,
        drag: 3,
        followRoot: 0.12,
        collisionMargin: 0.003,
        collisionFriction: 0.3,
      },
      style: { ...STRAND, collide: true },
      shading: SHADING,
    },
  },
  long: {
    uiColor: '#e07a5f',
    settings: {
      hairPerCm2: 105,
      guideSpacing: 0.0065,
      guideParticles: 20,
      strandPoints: 28,
      lengthScale: 1,
      lengthVariation: 0.25,
      widthVariation: 0.3,
      waveCount: 2.5,
    },
    params: {
      physics: {
        globalStiffness: 0.3,
        globalTip: 0,
        globalCurve: 3,
        globalRange: 0.45,
        localStiffness: 0.45,
        localTip: 0.3,
        damping: 1,
        drag: 2,
        followRoot: 0,
        collisionMargin: 0.004,
        collisionFriction: 0.35,
      },
      style: {
        ...STRAND,
        collide: true,
        clump: 0.36,
        clumpShape: 1.2,
        curlRadius: 0.0032,
        curlTurns: 3.5,
        curlRamp: 0.35,
        frizz: 0.0009,
        frizzFrequency: 5,
      },
      shading: SHADING,
    },
  },
  short: {
    uiColor: '#81b29a',
    settings: {
      hairPerCm2: 120,
      guideSpacing: 0.006,
      guideParticles: 6,
      strandPoints: 6,
      lengthScale: 1,
      lengthVariation: 0.3,
      widthVariation: 0.3,
      waveCount: 0,
    },
    params: {
      physics: {
        globalStiffness: 0.6,
        globalTip: 0.6,
        localStiffness: 0.9,
        localTip: 0.8,
        damping: 9,
        drag: 3,
        followRoot: 0.5,
        collisionMargin: 0.002,
      },
      style: { ...STRAND, rootWidth: 0.00012, tipWidth: 0.00004, clump: 0.1, frizz: 0.0002 },
      // Short hair shows mostly its tips: keep them dark, like stubble, not sun-bleached ends.
      shading: { ...SHADING, rootColor: '#1f140c', tipColor: '#3a2718', specular: 0.35, tipFade: 0.1 },
    },
  },
  fringe: {
    uiColor: '#f2cc8f',
    settings: {
      hairPerCm2: 120,
      guideSpacing: 0.005,
      guideParticles: 12,
      strandPoints: 16,
      lengthScale: 1,
      lengthVariation: 0.25,
      widthVariation: 0.3,
      waveCount: 1,
    },
    params: {
      physics: {
        globalStiffness: 0.35,
        globalTip: 0.3,
        localStiffness: 0.7,
        localTip: 0.5,
        damping: 6,
        drag: 3,
        followRoot: 0.1,
        collisionMargin: 0.003,
        collisionFriction: 0.3,
      },
      style: { ...STRAND, collide: true, clump: 0.3 },
      shading: SHADING,
    },
  },
  beard: {
    uiColor: '#9c89b8',
    settings: {
      hairPerCm2: 90,
      guideSpacing: 0.005,
      guideParticles: 8,
      strandPoints: 8,
      lengthScale: 1,
      lengthVariation: 0.4,
      widthVariation: 0.35,
      waveCount: 1.5,
    },
    params: {
      physics: {
        globalStiffness: 0.5,
        globalTip: 0.5,
        localStiffness: 0.8,
        localTip: 0.7,
        damping: 8,
        drag: 3,
        followRoot: 0.4,
        collisionMargin: 0.002,
      },
      style: { ...STRAND, rootWidth: 0.00018, tipWidth: 0.00005, clump: 0.15, frizz: 0.0006 },
      shading: { ...SHADING, rootColor: '#1f140c', tipColor: '#5a3e28' },
    },
  },
  brows: {
    uiColor: '#4ea8de',
    settings: {
      hairPerCm2: 80,
      guideSpacing: 0.004,
      guideParticles: 5,
      strandPoints: 6,
      lengthScale: 1,
      lengthVariation: 0.35,
      widthVariation: 0.3,
      waveCount: 0,
    },
    params: {
      physics: {
        globalStiffness: 0.8,
        globalTip: 0.7,
        localStiffness: 0.9,
        localTip: 0.8,
        damping: 9,
        drag: 3,
        followRoot: 0.8,
        collisionMargin: 0.0015,
      },
      style: { ...STRAND, rootWidth: 0.00014, tipWidth: 0.00004, clump: 0.2, frizz: 0.0002 },
      shading: { ...SHADING, rootColor: '#1a120c', tipColor: '#3b2a1e' },
    },
  },
};

let nextId = 1;
export function newLayerId(): string {
  return `layer${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

/**
 * What a new layer is made with: scalp hair's settings and physics, with enough points along a guide and a strand
 * for long hair too (its length is painted).
 */
export const NEW_LAYER: LayerTemplate = {
  ...LAYER_TEMPLATES.scalp,
  settings: { ...LAYER_TEMPLATES.scalp.settings, guideParticles: 16, strandPoints: 20 },
};

/**
 * What a layer's maps hold where nothing is painted yet, so the first density stroke grows hair that the other
 * brushes then shape: medium-length hair, combed down.
 */
const UNPAINTED = { length: 0.07, lift: 0.3, curve: 10, gravity: 0.5, wave: 0 };

/** Colours of new layers in the list (and their painting overlay), in turn. */
export const LAYER_COLORS = ['#f0b35a', '#e07a5f', '#81b29a', '#f2cc8f', '#9c89b8', '#4ea8de'];

/** A layer made with `template` over `count` paint vertices, with nothing painted (its maps hold UNPAINTED). */
export function createLayer(
  template: LayerTemplate,
  count: number,
  substeps: number,
  seed = 1 + Math.floor(Math.random() * 1e6),
): Layer {
  const fields = createFields(count);
  fields.length.fill(UNPAINTED.length);
  fields.lift.fill(UNPAINTED.lift);
  fields.curve.fill(UNPAINTED.curve);
  fields.gravity.fill(UNPAINTED.gravity);
  fields.wave.fill(UNPAINTED.wave);
  for (let i = 0; i < count; i++) fields.flow[i * 3 + 1] = -1;
  const params = mergeHairParams(structuredClone(template.params));
  params.physics.substeps = substeps;
  return {
    id: newLayerId(),
    name: 'Layer',
    visible: true,
    locked: false,
    uiColor: template.uiColor,
    settings: { ...template.settings, seed },
    params,
    fields,
  };
}

/** An empty layer on a bust (NEW_LAYER, combed down the head): nothing grows until its density is painted. */
export function emptyLayer(
  bust: { head: { frame: HeadFrame }; paint: PaintMesh },
  substeps: number,
  seed?: number,
): Layer {
  const layer = createLayer(NEW_LAYER, bust.paint.count, substeps, seed);
  applyFlowPreset('down', bust.head.frame, bust.paint, layer.fields.flow);
  return layer;
}

/** Strand and guide count limits per layer (before the quality preset scales them). */
export const MAX_LAYER_STRANDS = 250_000;
export const MAX_LAYER_GUIDES = 6000;

/** Painted area of a density map (m²): each triangle's area × its mean corner density (bare spots excluded). */
export function paintedArea(
  mesh: GrowthMesh,
  fieldIndex: Int32Array,
  density: Float32Array,
  bare: Float32Array | null,
): number {
  const p = mesh.positions;
  let area = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i0 = mesh.indices[t * 3];
    const i1 = mesh.indices[t * 3 + 1];
    const i2 = mesh.indices[t * 3 + 2];
    const d = (f: number) => density[f] * (bare ? 1 - bare[f] : 1);
    const mean = (d(fieldIndex[i0]) + d(fieldIndex[i1]) + d(fieldIndex[i2])) / 3;
    if (mean <= 0) continue;
    const ax = p[i1 * 3] - p[i0 * 3];
    const ay = p[i1 * 3 + 1] - p[i0 * 3 + 1];
    const az = p[i1 * 3 + 2] - p[i0 * 3 + 2];
    const bx = p[i2 * 3] - p[i0 * 3];
    const by = p[i2 * 3 + 1] - p[i0 * 3 + 1];
    const bz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
    area += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) * mean;
  }
  return area;
}

/** Strand and guide counts for a painted area (m²), before quality scaling. */
export function layerCounts(s: LayerSettings, area: number): { strands: number; guides: number } {
  const strands = Math.min(MAX_LAYER_STRANDS, Math.round(area * 1e4 * s.hairPerCm2));
  // Guides about `guideSpacing` apart (hexagonal packing: 0.866·s² of surface each).
  const guides = Math.min(MAX_LAYER_GUIDES, Math.round(area / (0.866 * s.guideSpacing * s.guideSpacing)));
  return { strands, guides: Math.max(1, Math.min(guides, strands)) };
}

/** The layer as a painted-style group, or null when too little is painted to grow anything. */
export function paintedLayer(layer: Layer, area: number): PaintedLayer | null {
  const { strands, guides } = layerCounts(layer.settings, area);
  if (strands < 16 || guides < 3) return null;
  const s = layer.settings;
  const spec: GroomGroupSpec = {
    name: layer.id,
    guideCount: guides,
    strandCount: strands,
    guideParticles: s.guideParticles,
    strandPoints: s.strandPoints,
    lengthVariation: s.lengthVariation,
    widthVariation: s.widthVariation,
    interpSpace: 'world',
    seed: s.seed,
  };
  // Live: the length scale and wave count sliders reshape the hair without rebuilding the style.
  return {
    spec,
    fields: layer.fields,
    get lengthScale() {
      return s.lengthScale;
    },
    get waveCount() {
      return s.waveCount;
    },
  };
}
