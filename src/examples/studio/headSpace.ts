import * as THREE from 'three/webgpu';

import { lerpTable } from '../../hair/groom/styles/mulletStyle';
import type { Ellipsoid, HeadFrame } from './heads';
import type { PaintMesh } from './paintMesh';

export type FlowPreset =
  | 'crown'
  | 'back'
  | 'down'
  | 'forward'
  | 'partLeft'
  | 'partCenter'
  | 'partRight'
  | 'outward';

export const FLOW_PRESETS: Record<FlowPreset, string> = {
  crown: 'from the crown',
  back: 'comb back',
  down: 'comb down',
  forward: 'comb forward',
  partLeft: 'part on the left',
  partCenter: 'part in the middle',
  partRight: 'part on the right',
  outward: 'outward (brows)',
};

/** Smoothstep from edge a to edge b (b < a runs downwards), as in mulletStyle. */
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Azimuth around the head's vertical axis in degrees: 0 = front (+z), ±180 = back, positive towards +x. */
export function azimuth(frame: HeadFrame, p: THREE.Vector3): number {
  return (Math.atan2(p.x - frame.midlineX, p.z - frame.center.z) * 180) / Math.PI;
}

/** 1 well inside any of the ellipsoids, 0 outside (a soft edge around the surface). */
export function ellipsoidMask(list: Ellipsoid[], p: THREE.Vector3): number {
  let k = 0;
  for (const e of list) {
    const dx = (p.x - e.c.x) / e.r.x;
    const dy = (p.y - e.c.y) / e.r.y;
    const dz = (p.z - e.c.z) / e.r.z;
    k = Math.max(k, 1 - smoothstep(0.85, 1.05, Math.sqrt(dx * dx + dy * dy + dz * dz)));
  }
  return k;
}

/**
 * 0..1: the scalp above the head's hairline, off the ears, with a soft edge around the line. `offset` lowers the
 * hairline.
 */
export function scalpMask(frame: HeadFrame, p: THREE.Vector3, offset = 0): number {
  const line = lerpTable(frame.hairline, Math.abs(azimuth(frame, p))) - offset;
  const r = frame.radii.y;
  return smoothstep(line - 0.055 * r, line + 0.082 * r, p.y) * (1 - ellipsoidMask(frame.ears, p));
}

/** Per paint vertex: where hair never grows (eyes, lips), 0..1. Null if the head has no such places. */
export function bareMap(frame: HeadFrame, paint: PaintMesh): Float32Array | null {
  if (!frame.bare.length) return null;
  const out = new Float32Array(paint.count);
  const p = new THREE.Vector3();
  for (let i = 0; i < paint.count; i++)
    out[i] = ellipsoidMask(frame.bare, p.fromArray(paint.positions, i * 3));
  return out;
}

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * A preset comb direction at a model-space point with normal `n`, on its tangent plane. Hair whorls from the crown,
 * parts away from a parting line on top and falls down the sides and back.
 */
export function presetFlow(
  preset: FlowPreset,
  frame: HeadFrame,
  p: THREE.Vector3,
  n: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const c = frame.center;
  // How far up the head the point is: 0 at the ear tops, 1 on top.
  const up = smoothstep(c.y - 0.1 * frame.radii.y, c.y + 0.75 * frame.radii.y, p.y);
  switch (preset) {
    case 'back':
      out.set(0, -0.25, -1);
      break;
    case 'down':
      out.copy(DOWN);
      break;
    case 'forward':
      out.set(0, -0.35, 1);
      break;
    case 'crown': {
      // Radiates from the whorl over the top, turning down the sides and back.
      out.subVectors(p, frame.crown).setY(0);
      if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
      out
        .normalize()
        .multiplyScalar(up)
        .addScaledVector(DOWN, 1 - up);
      break;
    }
    case 'partLeft':
    case 'partCenter':
    case 'partRight': {
      // The parting runs front to back; its left is the face's own left (+x, it faces +z).
      const side = preset === 'partLeft' ? 0.45 : preset === 'partRight' ? -0.45 : 0;
      const partX = frame.midlineX + side * frame.radii.x;
      const away = Math.sign(p.x - partX) || 1;
      out
        .set(away, 0, -0.15)
        .normalize()
        .multiplyScalar(up)
        .addScaledVector(DOWN, 1 - up);
      break;
    }
    case 'outward':
      out.set(Math.sign(p.x - frame.midlineX) || 1, 0.25, 0.1);
      break;
  }
  out.addScaledVector(n, -n.dot(out));
  if (out.lengthSq() < 1e-8) out.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
  if (out.lengthSq() < 1e-8) out.set(1, 0, 0).addScaledVector(n, -n.x);
  return out.normalize();
}

/** Writes a flow preset into a flow map (3 floats per paint vertex). */
export function applyFlowPreset(
  preset: FlowPreset,
  frame: HeadFrame,
  paint: PaintMesh,
  flow: Float32Array,
): void {
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const f = new THREE.Vector3();
  for (let i = 0; i < paint.count; i++) {
    presetFlow(preset, frame, p.fromArray(paint.positions, i * 3), n.fromArray(paint.normals, i * 3), f);
    f.toArray(flow, i * 3);
  }
}

/** The scalp mask as a density map over the paint vertices. */
export function scalpDensity(frame: HeadFrame, paint: PaintMesh, offset = 0): Float32Array {
  const out = new Float32Array(paint.count);
  const p = new THREE.Vector3();
  for (let i = 0; i < paint.count; i++)
    out[i] = scalpMask(frame, p.fromArray(paint.positions, i * 3), offset);
  return out;
}
