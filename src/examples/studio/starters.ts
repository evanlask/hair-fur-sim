import * as THREE from 'three/webgpu';

import { deepMerge, type DeepPartial, type HairParamsData } from '../../hair/params';
import { gatherDistances } from './gather';
import type { HeadFrame } from './heads';
import { applyFlowPreset, azimuth, scalpMask, type FlowPreset } from './headSpace';
import {
  LAYER_TEMPLATES,
  createLayer,
  type Layer,
  type LayerSettings,
  type LayerTemplateName,
} from './layers';
import type { StudioBust } from './StudioBust';

/** The head a starter style is built on: its landmarks, and points on its skin. */
interface StarterHead {
  frame: HeadFrame;
  /** Model units → meters. */
  scale: number;
  /**
   * The skin point nearest the cranium point (nx, ny, nz) in cranium radii from its centre (model units): e.g.
   * (0, 0.05, −1) is the back of the head, where a ponytail is tied.
   */
  surface(nx: number, ny: number, nz: number): THREE.Vector3;
  /** Distance (m) over the skin from a paint vertex to a landmark (see gatherDistances). */
  pathTo(at: At, vertex: number): number;
}

/** Where a paint vertex is on the head, for the starter styles (model units). */
interface HeadPoint {
  head: StarterHead;
  /** Its paint vertex. */
  vertex: number;
  p: THREE.Vector3;
  n: THREE.Vector3;
  /** Degrees round the head from the front (+ towards the face's left, +x). */
  az: number;
  /** 0 at the ear tops … 1 on top of the head. */
  up: number;
  /** 0..1: the scalp above this head's hairline, off the ears. */
  scalp: number;
  /** |x| from the midline over the cranium's half-width. */
  side: number;
  /** How far forward on the cranium: (z − centre) / depth radius (0 = over the ears, 1 = the forehead). */
  fwd: number;
  /** Height over the cranium's centre in its vertical radius (about 1 on top, −1.4 at the nape). */
  y: number;
  /** Side-view offset from the nearer ear's centre, in cranium radii: up and forward (Infinity without ears). */
  earUp: number;
  earFwd: number;
  /** A random number per vertex (0..1), for choppy ends. */
  rand: number;
}

interface StarterLayer {
  name: string;
  template: LayerTemplateName;
  density(h: HeadPoint): number;
  /** Meters. */
  length(h: HeadPoint): number;
  /** Comb direction: a preset, or a model-space direction per vertex (laid onto the skin). */
  flow: FlowPreset | ((h: HeadPoint, out: THREE.Vector3) => void);
  lift(h: HeadPoint): number;
  curve(h: HeadPoint): number;
  gravity(h: HeadPoint): number;
  wave?(h: HeadPoint): number;
  settings?: Partial<LayerSettings>;
  params?: DeepPartial<HairParamsData>;
  /** Gathered there, as by a hair tie (LayerSettings.gather). */
  gatherAt?: At;
}

export interface StarterStyle {
  id: string;
  label: string;
  /** Builds the style's layers on a bust. */
  build(bust: StudioBust, substeps: number): Layer[];
}

const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const front = (h: HeadPoint) => Math.max(0, Math.cos((h.az * Math.PI) / 180));
const back = (h: HeadPoint) => Math.max(0, -Math.cos((h.az * Math.PI) / 180));
/** The fringe: the front of the scalp, from the hairline back to about the top of the forehead. */
const fringeZone = (h: HeadPoint) => ss(0.25, 0.45, h.fwd) * ss(55, 35, Math.abs(h.az));
/** A mohawk's strip along the middle of the head. */
const strip = (h: HeadPoint) => ss(0.36, 0.26, h.side);
/** Side-view distance from the ear in the burst fade's radii (1 at its edge, which reaches further behind the ear). */
const burst = (h: HeadPoint) => Math.hypot(h.earUp / 0.72, h.earFwd / (h.earFwd > 0 ? 0.42 : 0.6));
/** The modern mullet's zones: the fade round each ear, the long back, and the top (all the rest). */
const fadeZone = (h: HeadPoint) => ss(1, 0.82, burst(h));
const backZone = (h: HeadPoint) => (1 - fadeZone(h)) * ss(105, 135, Math.abs(h.az)) * ss(0.4, 0.15, h.y);
const topZone = (h: HeadPoint) => Math.max(0, 1 - fadeZone(h) - backZone(h));

type At = [number, number, number];
/** Where hair is tied, in cranium radii from its centre: a ponytail at the back, a bun high on the crown. */
const PONY: At = [0, 0.05, -1];
const BUN: At = [0, 0.85, -0.4];
/** The rat tail's root, above the nape hairline. */
const NAPE: At = [0, -1.15, -0.8];
/** The top of the head an undercut leaves long (to the parietal ridge at the sides, the crown at the back). */
const topStrip = (h: HeadPoint) => ss(0.78, 0.66, h.side) * ss(0.3, 0.5, h.up);
/** Distance from a vertex to a skin landmark (m). */
const distTo = (h: HeadPoint, at: At) => h.p.distanceTo(h.head.surface(...at)) * h.head.scale;
/** Combs towards a skin landmark. */
const towards =
  (at: At) =>
  (h: HeadPoint, out: THREE.Vector3): void => {
    out.subVectors(h.head.surface(...at), h.p);
  };

/** A small seed per style and layer, so a style always grows the same hair. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 1_000_000;
}

function buildLayers(bust: StudioBust, id: string, defs: StarterLayer[], substeps: number): Layer[] {
  const { frame } = bust.head;
  const paint = bust.paint;
  const surfaceCache = new Map<string, THREE.Vector3>();
  const pathCache = new Map<string, Float32Array>();
  const head: StarterHead = {
    frame,
    scale: bust.head.scale,
    surface(nx, ny, nz) {
      const key = `${nx},${ny},${nz}`;
      let s = surfaceCache.get(key);
      if (!s) {
        const q = new THREE.Vector3(nx, ny, nz).multiply(frame.radii).add(frame.center);
        q.x += frame.midlineX - frame.center.x;
        let best = Infinity;
        s = new THREE.Vector3();
        const v = new THREE.Vector3();
        for (let i = 0; i < paint.count; i++) {
          const d = v.fromArray(paint.positions, i * 3).distanceToSquared(q);
          if (d < best) {
            best = d;
            s.copy(v);
          }
        }
        surfaceCache.set(key, s);
      }
      return s;
    },
    pathTo(at, vertex) {
      const key = at.join(',');
      let dist = pathCache.get(key);
      if (!dist) pathCache.set(key, (dist = gatherDistances(paint, this.surface(...at), bust.head.scale)));
      return dist[vertex];
    },
  };
  const hp: HeadPoint = {
    head,
    vertex: 0,
    p: new THREE.Vector3(),
    n: new THREE.Vector3(),
    az: 0,
    up: 0,
    scalp: 0,
    side: 0,
    fwd: 0,
    y: 0,
    earUp: Infinity,
    earFwd: Infinity,
    rand: 0,
  };
  const c = frame.center;
  return defs.map((d) => {
    const layer = createLayer(LAYER_TEMPLATES[d.template], paint.count, substeps, seedOf(`${id}:${d.name}`));
    layer.name = d.name;
    Object.assign(layer.settings, d.settings);
    if (d.gatherAt) layer.settings.gather = head.surface(...d.gatherAt).toArray() as At;
    if (d.params)
      deepMerge(
        layer.params as unknown as Record<string, unknown>,
        structuredClone(d.params) as Record<string, unknown>,
      );
    const f = layer.fields;
    const comb = typeof d.flow === 'function' ? d.flow : null;
    if (!comb) applyFlowPreset(d.flow as FlowPreset, frame, paint, f.flow);
    const dir = new THREE.Vector3();
    for (let i = 0; i < paint.count; i++) {
      hp.vertex = i;
      hp.p.fromArray(paint.positions, i * 3);
      hp.n.fromArray(paint.normals, i * 3);
      hp.az = azimuth(frame, hp.p);
      hp.up = ss(c.y - 0.1 * frame.radii.y, c.y + 0.75 * frame.radii.y, hp.p.y);
      hp.scalp = scalpMask(frame, hp.p);
      hp.side = Math.abs(hp.p.x - frame.midlineX) / frame.radii.x;
      hp.fwd = (hp.p.z - c.z) / frame.radii.z;
      hp.y = (hp.p.y - c.y) / frame.radii.y;
      const k = Math.sin(((hp.p.x - frame.midlineX) / frame.radii.x) * 127.1 + hp.y * 311.7 + hp.fwd * 74.7);
      hp.rand = (k * 43758.5453) % 1;
      if (hp.rand < 0) hp.rand += 1;
      let near = Infinity;
      for (const e of frame.ears) {
        const dist = hp.p.distanceToSquared(e.c);
        if (dist >= near) continue;
        near = dist;
        hp.earUp = (hp.p.y - e.c.y) / frame.radii.y;
        hp.earFwd = (hp.p.z - e.c.z) / frame.radii.z;
      }
      if (comb) {
        // Laid onto the skin (the flow is a unit tangent).
        comb(hp, dir);
        dir.addScaledVector(hp.n, -hp.n.dot(dir));
        if (dir.lengthSq() < 1e-10) dir.set(0, -1, 0).addScaledVector(hp.n, hp.n.y);
        dir.normalize().toArray(f.flow, i * 3);
      }
      f.density[i] = Math.min(1, Math.max(0, d.density(hp)));
      f.length[i] = d.length(hp);
      f.lift[i] = d.lift(hp);
      f.curve[i] = d.curve(hp);
      f.gravity[i] = d.gravity(hp);
      f.wave[i] = d.wave?.(hp) ?? 0;
    }
    return layer;
  });
}

const starter = (id: string, label: string, layers: StarterLayer[]): StarterStyle => ({
  id,
  label,
  build: (bust, substeps) => buildLayers(bust, id, layers, substeps),
});

/** One-click looks to start from (built on the head's own hairline and ears). */
export const STARTERS: StarterStyle[] = [
  starter('buzz', 'buzz cut', [
    {
      name: 'Buzz',
      template: 'short',
      density: (h) => h.scalp,
      length: () => 0.006,
      flow: 'crown',
      lift: () => 0.55,
      curve: () => 2,
      gravity: () => 0.1,
      // As dense as the density slider goes: clipped hair covers the scalp evenly.
      settings: { hairPerCm2: 300 },
    },
  ]),
  starter('crop', 'textured crop', [
    {
      name: 'Crop',
      template: 'scalp',
      density: (h) => h.scalp,
      length: (h) => 0.018 + 0.04 * h.up * (1 - 0.3 * back(h)),
      flow: 'forward',
      lift: (h) => 0.25 + 0.35 * h.up,
      curve: () => 7,
      gravity: (h) => 0.45 - 0.3 * h.up,
      wave: () => 0.0015,
    },
  ]),
  starter('sidePart', 'side part', [
    {
      name: 'Side part',
      template: 'scalp',
      density: (h) => h.scalp,
      length: (h) => 0.03 + 0.045 * h.up,
      flow: 'partLeft',
      lift: (h) => 0.15 + 0.25 * h.up,
      curve: () => 11,
      gravity: () => 0.3,
    },
  ]),
  starter('bob', 'bob with a fringe', [
    {
      name: 'Bob',
      template: 'long',
      density: (h) => h.scalp * (1 - fringeZone(h)),
      // A one-length cut at the jaw: longer from higher up, so the ends meet in a line, curling under a little.
      length: (h) => (0.075 + 0.085 * ss(-0.4, 1, h.y) + 0.025 * back(h)) * (0.95 + 0.1 * h.rand),
      flow: 'partCenter',
      lift: () => 0.12,
      curve: () => 13,
      gravity: () => 0.65,
      wave: () => 0.0015,
      settings: { lengthVariation: 0.06 },
      params: { style: { clump: 0.3, frizz: 0.0005, curlRadius: 0.001 } },
    },
    {
      name: 'Fringe',
      template: 'fringe',
      density: (h) => h.scalp * fringeZone(h),
      length: () => 0.085,
      flow: 'forward',
      lift: () => 0.2,
      curve: () => 12,
      gravity: () => 0.75,
      settings: { lengthVariation: 0.12 },
    },
  ]),
  starter('long', 'long, centre parting', [
    {
      name: 'Long hair',
      template: 'long',
      density: (h) => h.scalp,
      length: (h) => (0.36 - 0.08 * front(h)) * (0.94 + 0.12 * h.rand),
      // Away from the parting on top (the parting runs from the hairline to the crown), down everywhere else; at
      // the front out to the sides and a little back, so it falls beside the face like curtains, not over it.
      flow: (h, out) => {
        const parted = ss(0.25, 0.7, h.up) * ss(150, 110, Math.abs(h.az));
        const side = Math.sign(h.p.x - h.head.frame.midlineX) || 1;
        out.set(side * parted, -1 + 0.8 * parted, -0.35 * front(h) * parted);
      },
      // Flat from the roots, then soon falling: it drapes over the head instead of standing off it. The front keeps
      // its sweep longer, out past the temples, before it falls.
      lift: () => 0.03,
      curve: (h) => 28 - 16 * front(h) * ss(0.2, 0.6, h.up),
      gravity: () => 1,
      wave: () => 0.002,
      settings: { lengthVariation: 0.12 },
      params: {
        physics: { globalStiffness: 0.6, globalTip: 0.05 },
        style: { clump: 0.35, clumpShape: 1.3, frizz: 0.0005 },
      },
    },
  ]),
  starter('curly', 'curls', [
    {
      name: 'Curls',
      template: 'scalp',
      density: (h) => h.scalp,
      length: (h) => 0.1 + 0.04 * h.up,
      flow: 'crown',
      lift: () => 0.55,
      curve: () => 5,
      gravity: () => 0.35,
      wave: () => 0.008,
      settings: { waveCount: 3, strandPoints: 20, guideParticles: 14 },
      params: {
        physics: { globalStiffness: 0.45, localStiffness: 0.9 },
        style: { curlRadius: 0.004, curlTurns: 6, curlRamp: 0.15, frizz: 0.002, clump: 0.35 },
      },
    },
  ]),
  starter('mohawk', 'mohawk', [
    {
      name: 'Mohawk',
      template: 'scalp',
      density: (h) => h.scalp * strip(h),
      length: (h) => 0.06 + 0.04 * h.up,
      flow: 'back',
      lift: () => 0.95,
      curve: () => 1,
      gravity: () => 0,
      params: { physics: { globalStiffness: 0.85, globalTip: 0.8, localStiffness: 0.95, followRoot: 0.5 } },
    },
    {
      name: 'Shaved sides',
      template: 'short',
      density: (h) => h.scalp * (1 - strip(h)),
      length: () => 0.004,
      flow: 'crown',
      lift: () => 0.5,
      curve: () => 2,
      gravity: () => 0,
    },
  ]),
  starter('ponytail', 'ponytail', [
    {
      name: 'Pulled back',
      template: 'long',
      // All of it gathers at the tie, where the tail grows instead.
      density: (h) => h.scalp * ss(0.012, 0.02, distTo(h, PONY)),
      // Over the skin to the tie, and a little into the tail.
      length: (h) => h.head.pathTo(PONY, h.vertex) + 0.02,
      flow: towards(PONY),
      gatherAt: PONY,
      lift: () => 0,
      curve: () => 80,
      gravity: () => 1,
      settings: { lengthVariation: 0, waveCount: 0, guideParticles: 16, strandPoints: 24 },
      // Held by the tie: stiff all along, so it keeps lying on the head.
      params: {
        physics: {
          globalStiffness: 0.92,
          globalTip: 0.92,
          localStiffness: 0.92,
          localTip: 0.92,
          followRoot: 0.7,
          damping: 6,
        },
        style: { clump: 0.12, frizz: 0.0002, curlRadius: 0 },
      },
    },
    {
      name: 'Ponytail',
      template: 'long',
      density: (h) => ss(0.022, 0.014, distTo(h, PONY)),
      length: () => 0.3,
      flow: 'down',
      lift: () => 0.75,
      curve: () => 16,
      gravity: () => 1,
      wave: () => 0.004,
      // A whole head of hair comes out of a small patch: many strands per cm².
      settings: {
        hairPerCm2: 1600,
        guideSpacing: 0.004,
        waveCount: 2,
        lengthVariation: 0.25,
      },
      params: { physics: { globalStiffness: 0.22, localStiffness: 0.6 }, style: { clump: 0.55 } },
    },
  ]),
  starter('manBun', 'man bun', [
    {
      name: 'Top, slicked back',
      template: 'scalp',
      // The top of the head: back over the dome to the bun, flat on the skin.
      density: (h) => h.scalp * topStrip(h) * ss(0.016, 0.026, distTo(h, BUN)),
      // Over the skin to the bun, and a little into it.
      length: (h) => h.head.pathTo(BUN, h.vertex) + 0.015,
      flow: towards(BUN),
      gatherAt: BUN,
      lift: () => 0,
      curve: () => 80,
      gravity: () => 1,
      settings: { lengthVariation: 0, waveCount: 0, guideParticles: 14, strandPoints: 18 },
      // Held by the tie: stiff all along, so it keeps lying on the head.
      params: {
        physics: {
          globalStiffness: 0.92,
          globalTip: 0.92,
          localStiffness: 0.92,
          localTip: 0.92,
          followRoot: 0.7,
          damping: 6,
        },
        style: { clump: 0.15, frizz: 0.0002, curlRadius: 0 },
      },
    },
    {
      name: 'Bun',
      template: 'scalp',
      // A knot of the gathered hair: from a small patch at the tie, straight up and coiled round on itself.
      density: (h) => ss(0.024, 0.016, distTo(h, BUN)),
      length: () => 0.055,
      flow: 'crown',
      lift: () => 1,
      curve: () => 8,
      gravity: () => 0,
      wave: () => 0,
      settings: {
        hairPerCm2: 1600,
        guideSpacing: 0.003,
        waveCount: 1,
        guideParticles: 16,
        strandPoints: 24,
        lengthVariation: 0.2,
      },
      // Pinned in place, and twisted: the strands coil round it from the root, in a few ropes.
      params: {
        physics: {
          globalStiffness: 0.95,
          globalTip: 0.95,
          localStiffness: 0.95,
          localTip: 0.95,
          followRoot: 0.85,
        },
        style: { clump: 0.55, clumpShape: 1, curlRadius: 0.016, curlTurns: 2.2, curlRamp: 0, frizz: 0.0003 },
      },
    },
    {
      name: 'Undercut',
      template: 'short',
      density: (h) => h.scalp * (1 - topStrip(h)),
      length: (h) => 0.004 + 0.004 * h.up,
      flow: 'down',
      lift: () => 0.4,
      curve: () => 2,
      gravity: () => 0.2,
    },
  ]),
  starter('ratTail', 'rat tail', [
    {
      name: 'Crop',
      template: 'scalp',
      density: (h) => h.scalp * ss(0.01, 0.018, distTo(h, NAPE)),
      length: (h) => (0.018 + 0.035 * h.up * (1 - 0.3 * back(h))) * (0.85 + 0.3 * h.rand),
      flow: 'forward',
      lift: (h) => 0.25 + 0.3 * h.up,
      curve: () => 8,
      gravity: (h) => 0.45 - 0.3 * h.up,
      wave: () => 0.0015,
      params: { style: { clump: 0.4, frizz: 0.0006 } },
    },
    {
      name: 'Rat tail',
      template: 'long',
      // A thin rope from a small patch at the nape.
      density: (h) => ss(0.013, 0.007, distTo(h, NAPE)),
      length: () => 0.22,
      flow: 'down',
      lift: () => 0.1,
      curve: () => 6,
      gravity: () => 1,
      wave: () => 0.002,
      settings: { hairPerCm2: 1100, guideSpacing: 0.004, waveCount: 3, lengthVariation: 0.1 },
      params: {
        physics: { globalStiffness: 0.25, localStiffness: 0.7 },
        style: { clump: 0.95, clumpShape: 0.5, frizz: 0.0003 },
      },
    },
  ]),
  starter('mullet', 'modern mullet', [
    {
      name: 'Textured top',
      template: 'scalp',
      density: (h) => h.scalp * topZone(h),
      // Longest on top with a fringe; shorter down the sides into the fade, longer into the back; choppy ends.
      length: (h) =>
        ((0.03 + 0.04 * h.up + 0.008 * fringeZone(h)) *
          (0.6 + 0.4 * ss(0.9, 1.4, burst(h))) *
          (1 - 0.3 * ss(0.55, 0.9, h.side)) +
          0.03 * back(h) * ss(0.75, 0.35, h.up)) *
        (0.8 + 0.4 * h.rand),
      flow: 'crown',
      lift: (h) => (0.16 + 0.16 * h.up) * (1 - 0.5 * fringeZone(h)),
      curve: (h) => 13 + 5 * fringeZone(h),
      gravity: (h) => 0.55 + 0.25 * fringeZone(h),
      wave: () => 0.004,
      settings: { waveCount: 1.5 },
      params: {
        physics: { globalStiffness: 0.4 },
        style: { clump: 0.5, clumpShape: 1.2, frizz: 0.0007, curlRadius: 0.0015, curlTurns: 2 },
      },
    },
    {
      name: 'Burst fade',
      template: 'short',
      // Thinner towards the ear, so the skin shows through at the bottom of the fade.
      density: (h) => h.scalp * fadeZone(h) * (0.45 + 0.55 * ss(0.35, 0.85, burst(h))),
      length: (h) => 0.002 + 0.009 * ss(0.4, 1, burst(h)),
      flow: 'back',
      lift: () => 0.45,
      curve: () => 3,
      gravity: () => 0.15,
    },
    {
      name: 'Curly back',
      template: 'long',
      density: (h) => h.scalp * backZone(h),
      length: (h) => (0.11 + 0.03 * ss(0, -1.2, h.y)) * (0.8 + 0.2 * ss(120, 160, Math.abs(h.az))),
      flow: 'down',
      lift: () => 0.15,
      curve: () => 9,
      gravity: () => 0.85,
      // Big waves of the guides, which the strands clump to: curls in bunches rather than frizz.
      wave: () => 0.009,
      settings: { waveCount: 3.5, guideSpacing: 0.009, lengthVariation: 0.2 },
      params: {
        physics: { globalStiffness: 0.4, localStiffness: 0.85 },
        style: {
          clump: 0.75,
          clumpShape: 0.7,
          curlRadius: 0.0025,
          curlTurns: 6,
          curlRamp: 0.3,
          frizz: 0.0006,
        },
      },
    },
  ]),
];

export function starterById(id: string): StarterStyle | undefined {
  return STARTERS.find((s) => s.id === id);
}
