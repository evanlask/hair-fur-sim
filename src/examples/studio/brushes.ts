import * as THREE from 'three/webgpu';

import type { FieldName, PaintedFields } from '../../hair/groom/styles/paintedStyle';
import { valueNoise3 } from '../../util/noise';
import type { PaintMesh } from './paintMesh';

export type PaintTool =
  | 'density'
  | 'length'
  | 'comb'
  | 'part'
  | 'lift'
  | 'curve'
  | 'wave'
  | 'smooth'
  | 'noise';
export type Tool = 'navigate' | PaintTool;

/** The map channels each tool paints (comb and part paint the flow). */
export const TOOL_CHANNELS: Record<PaintTool, FieldName[]> = {
  density: ['density'],
  length: ['length'],
  comb: ['flow'],
  part: ['flow'],
  lift: ['lift'],
  curve: ['curve', 'gravity'],
  wave: ['wave'],
  smooth: ['length', 'flow', 'lift', 'curve', 'gravity', 'wave'],
  noise: ['length', 'flow', 'lift'],
};

/** The longest a length map holds (m, before the layer's length ×): what a saved groom can store. */
export const MAP_LENGTH_MAX = 2;

/** Shape tools regrow guides in place; density regrows the layer. */
export const isShapeTool = (t: PaintTool) => t !== 'density';

/** The channels a stroke changes: Smooth evens out the density or the shape channels, as the brush is set. */
export function strokeChannels(tool: PaintTool, smooth: BrushSettings['smooth']): FieldName[] {
  return tool === 'smooth' && smooth === 'density' ? ['density'] : TOOL_CHANNELS[tool];
}

/** Whether a stroke changes where hair grows (the layer regrows) rather than its shape (reshaped in place). */
export function changesDensity(tool: PaintTool, smooth: BrushSettings['smooth']): boolean {
  return tool === 'density' || (tool === 'smooth' && smooth === 'density');
}

export interface BrushSettings {
  /** Brush radius (m). */
  radius: number;
  /** How far one dab moves values towards the target (0..1). */
  strength: number;
  /** Target per tool: density 0..1, length (m), lift 0..1, curve (1/m), wave (m); for noise, its amount 0..1. */
  value: Record<'density' | 'length' | 'lift' | 'curve' | 'wave' | 'noise', number>;
  /** Curve tool: the gravity it paints along with the curve. */
  gravity: number;
  /** Length: only ever shorten (scissors). */
  cutOnly: boolean;
  /** Smooth: the channels it evens out ('shape' = all but density). */
  smooth: 'shape' | 'density';
  mirror: boolean;
}

export const defaultBrush = (): BrushSettings => ({
  radius: 0.02,
  strength: 0.5,
  value: { density: 1, length: 0.12, lift: 0.4, curve: 10, wave: 0.004, noise: 0.5 },
  gravity: 0.5,
  cutOnly: false,
  smooth: 'shape',
  mirror: true,
});

/** One brush dab, in model space (the paint mesh's units). */
export interface Dab {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  /** Stroke direction (unit), for comb and part. */
  direction: THREE.Vector3 | null;
  /** Radius in model units. */
  radius: number;
  /** Multiplies the strength (pen pressure). */
  pressure: number;
  /** ⌘ / Ctrl: erase, trim, flatten, straighten. */
  invert: boolean;
  /** The stroke's random seed: its noise pattern. */
  seed?: number;
  /** Set on a symmetry dab: the plane x = mirrorX it mirrors the stroke's own dab about (noise mirrors too). */
  mirrorX?: number;
}

/** Called with a paint vertex before a dab first changes it (for undo). */
export type BeforeChange = (vertex: number) => void;

/** A vertex's value in a channel (`e`: which flow component) as it was when the stroke first touched it. */
export type StartValue = (channel: FieldName, vertex: number, e?: number) => number;

/** The noise tool at full amount: how much it varies the length (a fraction), the comb direction (rad) and lift. */
const NOISE = { length: 0.5, flow: Math.PI / 4, lift: 0.25 };
/** The size of the noise's features, in brush radii. */
const NOISE_CELL = 0.5;

/** Smooth falloff: 1 at the centre, 0 at the radius. */
export function falloff(t: number): number {
  if (t >= 1) return 0;
  const s = Math.max(0, t);
  return 1 - s * s * (3 - 2 * s);
}

const tmp = {
  v: new THREE.Vector3(),
  n: new THREE.Vector3(),
  f: new THREE.Vector3(),
  t: new THREE.Vector3(),
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
};

/**
 * Applies one dab of `tool` to a layer's maps. Vertices within the radius are weighted by the falloff and by how
 * much they face the dab's normal (so strokes don't bleed through ears or round onto the other side).
 * Returns the vertices it changed. `start` gives the values from before the stroke (for noise; by default the
 * current ones).
 */
export function applyDab(
  tool: PaintTool,
  fields: PaintedFields,
  mesh: PaintMesh,
  dab: Dab,
  brush: BrushSettings,
  before: BeforeChange,
  start: StartValue = (ch, i, e = 0) => fields[ch][i * (ch === 'flow' ? 3 : 1) + e],
): number[] {
  const { positions: P, normals: Nm } = mesh;
  const r = dab.radius;
  const ring = Math.max(1, Math.ceil(r / mesh.hash.cellSize));
  const hits: number[] = [];
  const weights: number[] = [];
  const c = dab.center;
  mesh.hash.forEachNear(c.x, c.y, c.z, ring, (i, d2) => {
    if (d2 > r * r) return;
    const facing = Nm[i * 3] * dab.normal.x + Nm[i * 3 + 1] * dab.normal.y + Nm[i * 3 + 2] * dab.normal.z;
    const w = falloff(Math.sqrt(d2) / r) * THREE.MathUtils.smoothstep(facing, 0, 0.35);
    if (w <= 0) return;
    hits.push(i);
    weights.push(Math.min(1, w * brush.strength * dab.pressure));
  });
  if (tool === 'smooth') {
    smooth(fields, mesh, hits, weights, brush.smooth, before);
    return hits;
  }
  for (let k = 0; k < hits.length; k++) {
    const i = hits[k];
    const w = weights[k];
    before(i);
    switch (tool) {
      case 'density':
        towards(fields.density, i, dab.invert ? 0 : brush.value.density, w);
        break;
      case 'length': {
        const L = fields.length[i];
        if (dab.invert) fields.length[i] = L * (1 - 0.35 * w);
        else if (!brush.cutOnly || brush.value.length < L)
          towards(fields.length, i, Math.min(MAP_LENGTH_MAX, brush.value.length), w);
        break;
      }
      case 'lift':
        towards(fields.lift, i, dab.invert ? 0 : brush.value.lift, w);
        break;
      case 'curve':
        towards(fields.curve, i, dab.invert ? 0 : brush.value.curve, w);
        if (!dab.invert) towards(fields.gravity, i, brush.gravity, w);
        break;
      case 'wave':
        towards(fields.wave, i, dab.invert ? 0 : brush.value.wave, w);
        break;
      case 'comb':
        if (dab.direction) turnFlow(fields.flow, i, Nm, dab.direction, w);
        break;
      case 'part':
        if (dab.direction) {
          // Away from the parting line (through the centre along the stroke), on each side.
          const away = tmp.t.fromArray(P, i * 3).sub(c);
          away.addScaledVector(dab.direction, -away.dot(dab.direction));
          if (away.lengthSq() > 1e-12) turnFlow(fields.flow, i, Nm, away.normalize(), w);
        }
        break;
      case 'noise':
        roughen(fields, i, Nm, P, dab, brush.value.noise, w, start);
        break;
    }
  }
  return hits;
}

/**
 * Noise: towards a stroke's own random pattern around the values from before it, so dabbing on doesn't pile up more.
 * The pattern's features are about the brush's size; a mirrored dab reads it where the stroke's own dab was, and turns
 * the comb the other way round.
 */
function roughen(
  fields: PaintedFields,
  i: number,
  normals: Float32Array,
  positions: Float32Array,
  dab: Dab,
  amount: number,
  w: number,
  start: StartValue,
): void {
  const k = 1 / (dab.radius * NOISE_CELL);
  const mirrored = dab.mirrorX !== undefined;
  const x = (mirrored ? 2 * dab.mirrorX! - positions[i * 3] : positions[i * 3]) * k;
  const y = positions[i * 3 + 1] * k;
  const z = positions[i * 3 + 2] * k;
  const seed = dab.seed ?? 0;
  const noise = (channel: number) => valueNoise3(x, y, z, seed + channel) * 2 - 1;
  towards(
    fields.length,
    i,
    Math.min(MAP_LENGTH_MAX, start('length', i) * (1 + NOISE.length * amount * noise(0))),
    w,
  );
  towards(fields.lift, i, THREE.MathUtils.clamp(start('lift', i) + NOISE.lift * amount * noise(1), 0, 1), w);
  const angle = NOISE.flow * amount * noise(2) * (mirrored ? -1 : 1);
  const comb = tmp.a.set(start('flow', i, 0), start('flow', i, 1), start('flow', i, 2));
  const side = tmp.b.fromArray(normals, i * 3).cross(comb);
  comb.multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
  turnFlow(fields.flow, i, normals, comb, w);
}

function towards(f: Float32Array, i: number, target: number, w: number): void {
  f[i] += (target - f[i]) * w;
}

/** Turns a vertex's flow towards `dir` (projected onto its tangent plane) by `w`. */
function turnFlow(flow: Float32Array, i: number, normals: Float32Array, dir: THREE.Vector3, w: number): void {
  const n = tmp.n.fromArray(normals, i * 3);
  const t = tmp.v.copy(dir).addScaledVector(n, -n.dot(dir));
  if (t.lengthSq() < 1e-10) return;
  t.normalize();
  const f = tmp.f.fromArray(flow, i * 3).lerp(t, w);
  // Keep it on the tangent plane and unit length (a 180° turn passes through zero: then take the target).
  f.addScaledVector(n, -n.dot(f));
  if (f.lengthSq() < 1e-8) f.copy(t);
  f.normalize().toArray(flow, i * 3);
}

/** Moves each vertex towards the average of its neighbours (read from a snapshot, so the order doesn't matter). */
function smooth(
  fields: PaintedFields,
  mesh: PaintMesh,
  hits: number[],
  weights: number[],
  which: 'shape' | 'density',
  before: BeforeChange,
): void {
  const scalars: Float32Array[] =
    which === 'density'
      ? [fields.density]
      : [fields.length, fields.lift, fields.curve, fields.gravity, fields.wave];
  const { neighborStart: S, neighbors: Nb } = mesh;
  const next = hits.map((i) => {
    const out = scalars.map(() => 0);
    const flow = tmp.f.set(0, 0, 0);
    const n = S[i + 1] - S[i];
    for (let j = S[i]; j < S[i + 1]; j++) {
      const q = Nb[j];
      scalars.forEach((f, k) => (out[k] += f[q] / n));
      if (which === 'shape') flow.add(tmp.v.fromArray(fields.flow, q * 3));
    }
    return { out, flow: flow.clone(), n };
  });
  hits.forEach((i, k) => {
    const { out, flow, n } = next[k];
    if (n === 0) return;
    before(i);
    const w = weights[k];
    scalars.forEach((f, s) => (f[i] += (out[s] - f[i]) * w));
    if (which === 'shape' && flow.lengthSq() > 1e-10)
      turnFlow(fields.flow, i, mesh.normals, flow.normalize(), w);
  });
}

/** Reflects a model-space point about the midline plane x = midlineX. */
export function mirrorPoint(p: THREE.Vector3, midlineX: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(2 * midlineX - p.x, p.y, p.z);
}

export function mirrorDirection(d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-d.x, d.y, d.z);
}
