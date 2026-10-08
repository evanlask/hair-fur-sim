export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  name: QualityName;
  /** Multipliers on each example's default strand and guide counts. */
  strandScale: number;
  guideScale: number;
  renderScale: number;
  shadowMapSize: number;
  hairShadowSize: number;
  substeps: number;
}

export const QUALITY: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low',
    strandScale: 0.25,
    guideScale: 0.6,
    renderScale: 1,
    shadowMapSize: 1024,
    hairShadowSize: 384,
    substeps: 2,
  },
  medium: {
    name: 'medium',
    strandScale: 0.5,
    guideScale: 0.8,
    renderScale: 1.25,
    shadowMapSize: 1536,
    hairShadowSize: 512,
    substeps: 3,
  },
  high: {
    name: 'high',
    strandScale: 1,
    guideScale: 1,
    renderScale: 1.5,
    shadowMapSize: 2048,
    hairShadowSize: 640,
    substeps: 4,
  },
  ultra: {
    name: 'ultra',
    strandScale: 2,
    guideScale: 1.25,
    renderScale: 2,
    shadowMapSize: 4096,
    hairShadowSize: 1024,
    substeps: 6,
  },
};

export function getQuality(): QualityPreset {
  const q = new URLSearchParams(location.search).get('quality') as QualityName | null;
  return QUALITY[q && q in QUALITY ? q : 'high'];
}
