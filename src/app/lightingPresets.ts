import type { LightParams } from './LightRig';

/** A complete lighting look: lamps, environment map, exposure and backdrop tint. */
export interface LightingPreset {
  /** Equirectangular HDR in /env (lighting + reflections). */
  env: string;
  light: Omit<LightParams, 'shadowMapSize'>;
  /** Backdrop gradient: top (sky) and bottom (horizon), plus the floor colour (sRGB hex). */
  backdrop: { top: string; bottom: string; floor: string };
}

/**
 * Directions are azimuth (0 = from the front, +90 = from the subject's left / screen right,
 * 180 = from behind) and elevation in degrees. The key light is the sun where there is one.
 */
export const LIGHTING_PRESETS = {
  studio: {
    env: 'ferndale_studio_04_1k.hdr',
    light: {
      keyAzimuth: 35,
      keyElevation: 45,
      keyIntensity: 3.2,
      keyColor: '#fff3e6',
      rimAzimuth: 200,
      rimElevation: 30,
      rimIntensity: 2.6,
      rimColor: '#cfe2ff',
      fillAzimuth: -70,
      fillElevation: 15,
      fillIntensity: 0.5,
      fillColor: '#ffe9d6',
      // The studio map is lit with coloured gels; keep most of that colour off the hair.
      envIntensity: 0.6,
      envSaturation: 0.4,
      exposure: 1,
    },
    backdrop: { top: '#2a2d36', bottom: '#07080b', floor: '#1c1d22' },
  },
  'neutral studio': {
    env: 'monochrome_studio_02_1k.hdr',
    light: {
      keyAzimuth: 35,
      keyElevation: 45,
      keyIntensity: 3,
      keyColor: '#ffffff',
      rimAzimuth: 200,
      rimElevation: 30,
      rimIntensity: 2,
      rimColor: '#ffffff',
      fillAzimuth: -70,
      fillElevation: 15,
      fillIntensity: 0.6,
      fillColor: '#ffffff',
      envIntensity: 0.7,
      envSaturation: 1,
      exposure: 1,
    },
    backdrop: { top: '#2e2f31', bottom: '#09090a', floor: '#1e1e20' },
  },
  portrait: {
    env: 'monochrome_studio_02_1k.hdr',
    light: {
      // Chiaroscuro: one hard warm key from the side, a cool kicker behind the shadow side, no fill.
      keyAzimuth: -52,
      keyElevation: 38,
      keyIntensity: 4.8,
      keyColor: '#ffe0c0',
      rimAzimuth: -150,
      rimElevation: 28,
      rimIntensity: 2.2,
      rimColor: '#c4d4ff',
      fillAzimuth: 70,
      fillElevation: 10,
      fillIntensity: 0.03,
      fillColor: '#8fa0c0',
      envIntensity: 0.07,
      envSaturation: 1,
      exposure: 1,
    },
    backdrop: { top: '#141216', bottom: '#030304', floor: '#060507' },
  },
  sunrise: {
    env: 'blouberg_sunrise_2_1k.hdr',
    light: {
      keyAzimuth: -55,
      keyElevation: 9,
      keyIntensity: 3.8,
      keyColor: '#ffc184',
      rimAzimuth: 150,
      rimElevation: 25,
      rimIntensity: 1.2,
      rimColor: '#9cc0ff',
      fillAzimuth: 70,
      fillElevation: 20,
      fillIntensity: 0.35,
      fillColor: '#ffd2e0',
      envIntensity: 0.8,
      envSaturation: 0.9,
      exposure: 1.05,
    },
    backdrop: { top: '#34507a', bottom: '#d9a07c', floor: '#3a3330' },
  },
  midday: {
    env: 'quarry_01_1k.hdr',
    light: {
      keyAzimuth: 25,
      keyElevation: 68,
      keyIntensity: 4.2,
      keyColor: '#fff6e8',
      rimAzimuth: 200,
      rimElevation: 40,
      rimIntensity: 0.9,
      rimColor: '#ffffff',
      fillAzimuth: -90,
      fillElevation: 35,
      fillIntensity: 0.8,
      fillColor: '#b8d2ff',
      envIntensity: 0.9,
      envSaturation: 1,
      exposure: 0.85,
    },
    backdrop: { top: '#4f7fb6', bottom: '#a9bfd6', floor: '#5a5b5e' },
  },
  sunset: {
    env: 'venice_sunset_1k.hdr',
    light: {
      // Low sun behind the subject: strong warm back light through the hair.
      keyAzimuth: 140,
      keyElevation: 7,
      keyIntensity: 3.6,
      keyColor: '#ff8a45',
      rimAzimuth: -30,
      rimElevation: 30,
      rimIntensity: 0.8,
      rimColor: '#8a86ff',
      fillAzimuth: 60,
      fillElevation: 12,
      fillIntensity: 0.45,
      fillColor: '#ffb07a',
      envIntensity: 0.9,
      envSaturation: 0.9,
      exposure: 1.15,
    },
    backdrop: { top: '#2b2150', bottom: '#d3784a', floor: '#3a2a2a' },
  },
  evening: {
    env: 'moonless_golf_1k.hdr',
    light: {
      // Blue hour: dim cool sky light, warm street light from behind.
      keyAzimuth: -40,
      keyElevation: 30,
      keyIntensity: 1.2,
      keyColor: '#9fb6ff',
      rimAzimuth: 165,
      rimElevation: 18,
      rimIntensity: 2,
      rimColor: '#ffad60',
      fillAzimuth: 70,
      fillElevation: 10,
      fillIntensity: 0.3,
      fillColor: '#5a6db0',
      envIntensity: 1.5,
      envSaturation: 0.8,
      exposure: 1.35,
    },
    backdrop: { top: '#070a18', bottom: '#1d2747', floor: '#141824' },
  },
} satisfies Record<string, LightingPreset>;

export type LightingName = keyof typeof LIGHTING_PRESETS;
