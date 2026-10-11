import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { dirFromAngles } from '../util/angles';

/** Reference timestep that stiffness/damping values are defined against (so presets with
 *  different substep counts behave the same). */
export const DT_REF = 1 / 60;

/** Physics parameters (all live-tunable). */
export interface PhysicsParams {
  /** Solver substeps per 1/60 s (quality knob; coefficients are timestep-independent). */
  substeps: number;
  gravity: { x: number; y: number; z: number };
  /** Velocity damping rate in 1/s. */
  damping: number;
  /** Global shape stiffness per 1/60 s: pull towards the groomed rest pose (holds the style). */
  globalStiffness: number;
  /** Global stiffness multiplier at the tip (root is 1). */
  globalTip: number;
  /** Exponent of the root→tip global stiffness falloff. */
  globalCurve: number;
  /** Fraction of the strand (from the root) the global stiffness falls off over; beyond it, the tip value. */
  globalRange: number;
  /** Local shape stiffness per 1/60 s: keeps segment-to-segment angles (bend / curl retention). */
  localStiffness: number;
  /** Local stiffness multiplier at the tip. */
  localTip: number;
  /** Dynamic follow-the-leader velocity correction (0 = plain FTL, ~0.9 = natural). */
  dftlDamping: number;
  /** Fraction of the root's rigid motion applied to the whole strand (0 = full inertia). */
  followRoot: number;
  /** Max particle speed in m/s. */
  maxVelocity: number;
  collisionMargin: number;
  collisionFriction: number;
  /** Fraction of the strand (from the root) where colliders containing the root stay disabled. */
  rootColliderRange: number;
  /** Fraction of the strand (from the root) that ignores the body SDF (fur where skin folds onto skin). */
  sdfRootRange: number;
  /** Keeps particles at least this fraction of their rest height above the root's surface plane. */
  rootPlane: number;
  /** Fraction of the strand (from the root) the root-plane constraint applies to. */
  rootPlaneRange: number;
  /** Air drag rate (1/s) pulling the perpendicular velocity towards the wind velocity (see `hairWind`). */
  drag: number;
}

/** Scene-wide wind (live). The air is shared; each group's `drag` sets how strongly its hair follows it. */
export interface WindParams {
  /** Off = still air (the solver also skips the wind noise). */
  enabled: boolean;
  /** Direction the wind blows from, in degrees around the vertical axis (same angles as the lamps). */
  azimuth: number;
  /** Degrees above the horizon the wind blows from (negative = updraft). */
  elevation: number;
  /** Wind speed in m/s. */
  strength: number;
  turbulence: number;
  frequency: number;
  gust: number;
  /** Seconds between gusts at any one spot; the gust fronts roll downwind at the wind speed. */
  gustPeriod: number;
}

/** Render-strand styling (live). */
export interface StyleParams {
  /** 0 = render strands copy only their nearest guide, 1 = smooth 3-guide blend. */
  guideBlend: number;
  clump: number;
  clumpShape: number;
  curlRadius: number;
  curlTurns: number;
  curlRamp: number;
  frizz: number;
  frizzFrequency: number;
  rootWidth: number;
  tipWidth: number;
  taper: number;
  minPixelWidth: number;
  /** Fraction of baked render strands drawn (density). */
  density: number;
  /** Automatic LOD: thin strands when they get too dense on screen. */
  lodEnabled: boolean;
  /** Strands per pixel above which LOD starts thinning. */
  lodStrandsPerPixel: number;
  /** Width compensation exponent for LOD (1 = preserve coverage, 0.5 = compromise). */
  lodWidthExponent: number;
  /**
   * Draw LOD: draw every 2nd–4th strand point while segments stay at most this long on screen (device pixels),
   * so far-away or small hair uses fewer triangles. 0 = always draw every point.
   */
  lodSegmentPx: number;
  /**
   * Sub-pixel LOD: while strands are thinner on screen than `minPixelWidth`, draw fewer of them (down to this
   * fraction), each proportionally wider. Their coverage is the same on average; the hair just has fewer distinct
   * strands. Up close, where strands are a pixel or more wide, every strand is drawn. 1 = off.
   */
  lodSubpixelDensity: number;
  /** Push render strands out of colliders (long hair on shoulders). */
  collide: boolean;
  /** Skip strands whose root is outside the camera view (padded by the strand length, so their shadows stay). */
  cullOffscreen: boolean;
  /**
   * Beyond this camera distance (m) strands thin out as (lodDistance / distance)^1.5, widening the rest so the
   * coverage stays about the same (0 = off). Per strand, unlike the whole-groom LOD above, so it suits grooms
   * spanning many depths.
   */
  lodDistance: number;
  /**
   * Skip strands whose root faces away from the camera (root normal · view < −backCull): fur on the far side of
   * the body is hidden by it. Higher only skips strands further past the silhouette; 0 = off. Long fur on thin
   * limbs shows further past the silhouette than short fur, so it needs a higher value.
   */
  backCull: number;
}

export interface ShadingParams {
  rootColor: string;
  tipColor: string;
  gradientStart: number;
  gradientEnd: number;
  /** How much per-strand baked colors (e.g. fur texture) tint the result. */
  textureInfluence: number;
  hueJitter: number;
  valueJitter: number;
  specular: number;
  roughness: number;
  shift: number;
  backlit: number;
  scatter: number;
  opacity: number;
  tipFade: number;
  selfShadowDensity: number;
  aoRoot: number;
  aoRange: number;
  ambient: number;
}

export interface HairParamsData {
  physics: PhysicsParams;
  style: StyleParams;
  shading: ShadingParams;
}

export const defaultPhysics = (): PhysicsParams => ({
  substeps: 4,
  gravity: { x: 0, y: -9.81, z: 0 },
  damping: 1.5,
  globalStiffness: 0.05,
  globalTip: 0.1,
  globalCurve: 1.0,
  globalRange: 1,
  localStiffness: 0.5,
  localTip: 0.6,
  dftlDamping: 0.9,
  followRoot: 0.0,
  maxVelocity: 12,
  collisionMargin: 0.004,
  collisionFriction: 0.3,
  rootColliderRange: 0.25,
  sdfRootRange: 0,
  rootPlane: 0.0,
  rootPlaneRange: 0.3,
  drag: 2,
});

export const defaultWind = (): WindParams => ({
  enabled: false,
  azimuth: -105,
  elevation: 0,
  strength: 0,
  turbulence: 0.5,
  frequency: 0.8,
  gust: 0.5,
  gustPeriod: 6,
});

export const defaultStyle = (): StyleParams => ({
  guideBlend: 1,
  clump: 0.25,
  clumpShape: 1.5,
  curlRadius: 0,
  curlTurns: 4,
  curlRamp: 0.25,
  frizz: 0.0015,
  frizzFrequency: 6,
  rootWidth: 0.00018,
  tipWidth: 0.00004,
  taper: 1.5,
  minPixelWidth: 1.0,
  density: 1,
  lodEnabled: true,
  lodStrandsPerPixel: 6,
  lodWidthExponent: 0.75,
  lodSegmentPx: 12,
  lodSubpixelDensity: 0.6,
  collide: false,
  cullOffscreen: true,
  lodDistance: 0,
  backCull: 0,
});

export const defaultShading = (): ShadingParams => ({
  rootColor: '#2a160c',
  tipColor: '#6b4428',
  gradientStart: 0.0,
  gradientEnd: 1.0,
  textureInfluence: 1,
  hueJitter: 0.03,
  valueJitter: 0.18,
  specular: 0.5,
  roughness: 0.35,
  shift: 0.035,
  backlit: 0.6,
  scatter: 0.6,
  opacity: 1,
  tipFade: 0.25,
  selfShadowDensity: 300,
  aoRoot: 0.35,
  aoRange: 0.35,
  ambient: 1,
});

export function defaultHairParams(): HairParamsData {
  return { physics: defaultPhysics(), style: defaultStyle(), shading: defaultShading() };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Deep-merges a partial params object into defaults. */
export function mergeHairParams(overrides: DeepPartial<HairParamsData> = {}): HairParamsData {
  return deepMerge(
    defaultHairParams() as unknown as Record<string, unknown>,
    overrides as Record<string, unknown>,
  ) as unknown as HairParamsData;
}

export function deepMerge(
  target: Record<string, unknown>,
  src: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}

const tmpColor = new THREE.Color();
const tmpVec = new THREE.Vector3();

/**
 * The one wind every hair group feels: plain params plus uniform nodes that each group's
 * `HairUniforms` references directly, so `sync()` updates all hair at once.
 */
class SharedWind {
  readonly params = defaultWind();
  /** Wind velocity (direction · speed) in m/s. */
  readonly velocity = uniform(new THREE.Vector3());
  readonly turbulence = uniform(0);
  readonly frequency = uniform(0);
  readonly gust = uniform(0);
  /** Gust front angular frequency (rad/s) and wavenumber along the wind (rad/m). */
  readonly gustOmega = uniform(1);
  readonly gustK = uniform(1);

  constructor() {
    this.sync();
  }

  sync(): void {
    const w = this.params;
    // Blows from (azimuth, elevation) towards the opposite side.
    const speed = w.enabled ? w.strength : 0;
    this.velocity.value.copy(dirFromAngles(w.azimuth, w.elevation, tmpVec).multiplyScalar(-speed));
    this.turbulence.value = w.turbulence;
    this.frequency.value = w.frequency;
    this.gust.value = w.gust;
    // Fronts travel at the wind speed: wavelength = speed · period.
    const period = Math.max(0.5, w.gustPeriod);
    this.gustOmega.value = (2 * Math.PI) / period;
    this.gustK.value = (2 * Math.PI) / (Math.max(speed, 0.1) * period);
  }
}

export const hairWind = new SharedWind();

/**
 * Uniform nodes mirroring a HairParamsData object. `sync()` copies plain values into uniforms
 * (cheap, called when the GUI changes something); `syncFrame()` updates per-frame timing values.
 */
export class HairUniforms {
  // timing
  readonly dtSub = uniform(1 / 240);
  /** Time-corrected Verlet ratio for the first substep; always 1 since substeps have a fixed length (see syncFrame). */
  readonly dtRatio = uniform(1);
  readonly substeps = uniform(4, 'uint');
  /** Exponent dt_sub / DT_REF used to make stiffness timestep-independent. */
  readonly stiffnessExponent = uniform(0.25);
  readonly time = uniform(0);
  /** 1 on the frame after a reset/teleport: previous root frame = current, no inertia. */
  readonly firstFrame = uniform(1, 'uint');
  // physics
  readonly gravity = uniform(new THREE.Vector3());
  readonly dampingFactor = uniform(1);
  readonly globalStiffness = uniform(0);
  readonly localStiffness = uniform(0);
  readonly dftlDamping = uniform(0);
  readonly followRoot = uniform(0);
  readonly maxVelocity = uniform(0);
  readonly collisionMargin = uniform(0);
  readonly collisionFriction = uniform(0);
  readonly rootColliderRange = uniform(0.25);
  readonly sdfRootRange = uniform(0);
  readonly rootPlane = uniform(0);
  readonly rootPlaneRange = uniform(0);
  // wind: shared by every group (see hairWind)
  readonly wind = hairWind.velocity;
  readonly windTurbulence = hairWind.turbulence;
  readonly windFrequency = hairWind.frequency;
  readonly windGust = hairWind.gust;
  readonly windGustOmega = hairWind.gustOmega;
  readonly windGustK = hairWind.gustK;
  readonly drag = uniform(1);
  // style
  readonly guideBlend = uniform(1);
  readonly clump = uniform(0);
  readonly clumpShape = uniform(1);
  readonly curlRadius = uniform(0);
  readonly curlTurns = uniform(0);
  readonly curlRamp = uniform(0.2);
  readonly frizz = uniform(0);
  readonly frizzFrequency = uniform(1);
  readonly collideStrands = uniform(0, 'uint');
  readonly cullOffscreen = uniform(0, 'uint');
  readonly lodDistance = uniform(0);
  readonly backCull = uniform(0);
  /** Every n-th strand point is drawn (draw LOD); the shade kernel skips the others. */
  readonly drawStride = uniform(1, 'uint');
  /** Strands drawn into the hair shadow map (a prefix): hidden strands beyond it needn't be interpolated. */
  readonly shadowStrandCount = uniform(0, 'uint');
  readonly rootWidth = uniform(0);
  readonly tipWidth = uniform(0);
  readonly taper = uniform(1);
  readonly minPixelWidth = uniform(1);
  /** Width multiplier for LOD compensation (main pass). */
  readonly widthScale = uniform(1);
  /** Number of strands currently drawn (batch slots beyond it collapse). */
  readonly strandCount = uniform(0, 'uint');
  /** Strand index range over which the last drawn strands fade out, so LOD changes don't pop. */
  readonly lodFadeStart = uniform(1e9, 'uint');
  readonly lodFadeEnd = uniform(1e9, 'uint');
  // shading
  readonly rootColor = uniform(new THREE.Color());
  readonly tipColor = uniform(new THREE.Color());
  readonly gradientStart = uniform(0);
  readonly gradientEnd = uniform(1);
  readonly textureInfluence = uniform(1);
  readonly hueJitter = uniform(0);
  readonly valueJitter = uniform(0);
  readonly specular = uniform(0.5);
  readonly roughness = uniform(0.35);
  readonly shift = uniform(0.035);
  /** sin / cos of the R-lobe cuticle tilt (−2·shift), precomputed for the BSDF. */
  readonly cuticleSin = uniform(Math.sin(-0.07));
  readonly cuticleCos = uniform(Math.cos(-0.07));
  readonly backlit = uniform(0.6);
  readonly scatter = uniform(0.6);
  readonly opacity = uniform(1);
  readonly tipFade = uniform(0.2);
  readonly selfShadowDensity = uniform(900);
  readonly aoRoot = uniform(0.4);
  readonly aoRange = uniform(0.3);
  readonly ambient = uniform(1);

  private damping = 1;
  private substepRate = 4;
  /** Simulation time not yet simulated (fixed-step accumulator). */
  private accumulator = 0;
  /** Smoothed frame time (s), to detect very high refresh rates. */
  private frameDtAvg = 1 / 60;

  sync(p: HairParamsData): void {
    const ph = p.physics;
    this.substepRate = Math.max(1, Math.round(ph.substeps));
    this.gravity.value.set(ph.gravity.x, ph.gravity.y, ph.gravity.z);
    this.damping = ph.damping;
    this.globalStiffness.value = ph.globalStiffness;
    this.localStiffness.value = ph.localStiffness;
    this.dftlDamping.value = ph.dftlDamping;
    this.followRoot.value = ph.followRoot;
    this.maxVelocity.value = ph.maxVelocity;
    this.collisionMargin.value = ph.collisionMargin;
    this.collisionFriction.value = ph.collisionFriction;
    this.rootColliderRange.value = ph.rootColliderRange;
    this.sdfRootRange.value = ph.sdfRootRange;
    this.rootPlane.value = ph.rootPlane;
    this.rootPlaneRange.value = ph.rootPlaneRange;
    this.drag.value = ph.drag;

    const st = p.style;
    this.guideBlend.value = st.guideBlend;
    this.clump.value = st.clump;
    this.clumpShape.value = st.clumpShape;
    this.curlRadius.value = st.curlRadius;
    this.curlTurns.value = st.curlTurns;
    this.curlRamp.value = Math.max(1e-3, st.curlRamp);
    this.frizz.value = st.frizz;
    this.frizzFrequency.value = st.frizzFrequency;
    this.collideStrands.value = st.collide ? 1 : 0;
    this.cullOffscreen.value = st.cullOffscreen ? 1 : 0;
    this.lodDistance.value = st.lodDistance;
    this.backCull.value = st.backCull;
    this.rootWidth.value = st.rootWidth;
    this.tipWidth.value = st.tipWidth;
    this.taper.value = st.taper;
    this.minPixelWidth.value = st.minPixelWidth;

    const sh = p.shading;
    this.rootColor.value.copy(tmpColor.set(sh.rootColor));
    this.tipColor.value.copy(tmpColor.set(sh.tipColor));
    this.gradientStart.value = sh.gradientStart;
    this.gradientEnd.value = Math.max(sh.gradientStart + 1e-3, sh.gradientEnd);
    this.textureInfluence.value = sh.textureInfluence;
    this.hueJitter.value = sh.hueJitter;
    this.valueJitter.value = sh.valueJitter;
    this.specular.value = sh.specular;
    this.roughness.value = sh.roughness;
    this.shift.value = sh.shift;
    this.cuticleSin.value = Math.sin(-2 * sh.shift);
    this.cuticleCos.value = Math.cos(-2 * sh.shift);
    this.backlit.value = sh.backlit;
    this.scatter.value = sh.scatter;
    this.opacity.value = sh.opacity;
    this.tipFade.value = sh.tipFade;
    this.selfShadowDensity.value = sh.selfShadowDensity;
    this.aoRoot.value = sh.aoRoot;
    this.aoRange.value = Math.max(1e-3, sh.aoRange);
    this.ambient.value = sh.ambient;
  }

  /**
   * Per-frame timing. Substeps have a *fixed* length (1 / (60 · substeps) s) and the number run per
   * frame varies with the frame time, so uneven frame pacing can't inject energy (no
   * time-corrected Verlet rescaling). Coefficients are scaled for that fixed length.
   */
  syncFrame(frameDt: number, time: number): void {
    const dt = Math.min(Math.max(frameDt, 0), 1 / 15);
    // Frames always run at least one substep, so on displays faster than the substep rate (e.g.
    // 360 Hz) the substeps shorten to one frame; otherwise the simulation would outrun real time.
    this.frameDtAvg += (dt - this.frameDtAvg) * 0.05;
    const rate = Math.max(this.substepRate, Math.ceil(1 / (60 * Math.max(this.frameDtAvg, 1e-4)) - 0.01));
    const h = 1 / (60 * rate);
    this.accumulator += dt;
    const maxSteps = rate * 4;
    const n = Math.min(maxSteps, Math.max(1, Math.round(this.accumulator / h)));
    this.accumulator = Math.max(-h, this.accumulator - n * h);
    this.substeps.value = n;
    this.dtSub.value = h;
    this.dtRatio.value = 1;
    this.stiffnessExponent.value = h / DT_REF;
    this.dampingFactor.value = Math.exp(-this.damping * h);
    this.time.value = time;
  }
}

/** Per-particle profile along the strand (root→tip), uploaded as vec4 per particle:
 *  x = global stiffness multiplier, y = local stiffness multiplier, z = s (0..1), w = unused. */
export function buildParticleProfile(p: PhysicsParams, particles: number, out: Float32Array): void {
  for (let k = 0; k < particles; k++) {
    const s = particles > 1 ? k / (particles - 1) : 0;
    const sg = Math.min(1, s / Math.max(0.01, p.globalRange));
    const g = 1 + (p.globalTip - 1) * Math.pow(sg, Math.max(0.05, p.globalCurve));
    const l = 1 + (p.localTip - 1) * s;
    out[k * 4 + 0] = Math.max(0, g);
    out[k * 4 + 1] = Math.max(0, l);
    out[k * 4 + 2] = s;
    out[k * 4 + 3] = 0;
  }
}
