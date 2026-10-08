import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  clamp,
  color,
  float,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  positionLocal,
  pow,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

/** Profile point: half-width and height (meters, reference size); `sharp` breaks the shading there. */
interface ProfilePoint {
  w: number;
  y: number;
  sharp?: boolean;
}

/** Pedestal dimensions in meters. */
export interface PedestalSize {
  height: number;
  /** Half-width of the top slab; the mouldings scale with it and the die takes the remaining height. */
  topHalfWidth: number;
}

// Reference mouldings, drawn for a 0.244 m top half-width.
const REF_TOP = 0.244;
const BASE_HEIGHT = 0.09;
const CORNICE_HEIGHT = 0.108;
const DIE_WIDTH = 0.205;

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, steps: number): ProfilePoint[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = THREE.MathUtils.degToRad(a0 + ((a1 - a0) * i) / steps);
    return { w: cx + r * Math.cos(a), y: cy + r * Math.sin(a), sharp: i === 0 || i === steps };
  });

/** Base mouldings from the floor up: plinth block, torus, cove, fillet. */
const BASE: ProfilePoint[] = [
  { w: 0.25, y: 0, sharp: true },
  { w: 0.25, y: 0.034 },
  { w: 0.247, y: 0.04, sharp: true },
  ...arc(0.236, 0.054, 0.014, -90, 90, 8),
  { w: 0.226, y: 0.068, sharp: true },
  ...arc(0.226, 0.086, 0.014, -90, -180, 6),
  { w: 0.212, y: BASE_HEIGHT, sharp: true },
  { w: DIE_WIDTH, y: BASE_HEIGHT, sharp: true },
];

/** Cornice from the top of the die up: fillet, cyma (S-curve), corona slab with a chamfered edge. */
const CORNICE: ProfilePoint[] = [
  { w: DIE_WIDTH, y: 0, sharp: true },
  { w: 0.212, y: 0, sharp: true },
  ...Array.from({ length: 9 }, (_, i) => {
    const t = i / 8;
    return { w: 0.212 + 0.026 * t * t * (3 - 2 * t), y: 0.006 + 0.034 * t, sharp: i === 0 || i === 8 };
  }),
  { w: 0.244, y: 0.04, sharp: true },
  { w: 0.244, y: 0.102 },
  { w: 0.239, y: CORNICE_HEIGHT, sharp: true },
];

/** Vertical layout of a pedestal of the given size. */
function layout(size: PedestalSize) {
  const s = size.topHalfWidth / REF_TOP;
  return { s, dieBottom: BASE_HEIGHT * s, dieTop: size.height - CORNICE_HEIGHT * s };
}

/** Sweeps a profile (scaled by s, raised by y0) around a square: mitred corners, hard edges at sharp points. */
function squareSweep(profile: ProfilePoint[], s: number, y0: number): THREE.BufferGeometry {
  // Split into smooth runs at sharp points (a sharp point ends one run and starts the next).
  const runs: ProfilePoint[][] = [];
  let run: ProfilePoint[] = [];
  for (const p of profile) {
    run.push(p);
    if (p.sharp && run.length > 1) {
      runs.push(run);
      run = [p];
    }
  }
  if (run.length > 1) runs.push(run);

  const positions: number[] = [];
  const indices: number[] = [];
  for (let side = 0; side < 4; side++) {
    const rot = (side * Math.PI) / 2;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    for (const r of runs) {
      const base = positions.length / 3;
      for (const p of r) {
        // Side facing +z, rotated about y: corners (−w, y, w) and (w, y, w).
        const w = p.w * s;
        for (const x of [-w, w]) positions.push(x * c + w * sn, y0 + p.y * s, -x * sn + w * c);
      }
      for (let i = 0; i + 1 < r.length; i++) {
        const a = base + i * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  // mergeGeometries needs all parts indexed or none, and the die and cap aren't.
  return g.toNonIndexed();
}

/** The die (pedestal body) with a framed, recessed panel on each face. */
function panelledDie(s: number, y0: number, y1: number): THREE.BufferGeometry {
  const w = DIE_WIDTH * s;
  const border = 0.032 * s;
  const bevel = 0.007 * s;
  const depth = 0.006 * s;
  // Rectangles (x0, x1, y0, y1, z) on the +z face: outer, frame inner edge, recessed panel.
  const rects = [
    [-w, w, y0, y1, w],
    [-w + border, w - border, y0 + border, y1 - border, w],
    [-w + border + bevel, w - border - bevel, y0 + border + bevel, y1 - border - bevel, w - depth],
  ];
  const corner = (r: number[], k: number): number[] => [
    k === 0 || k === 3 ? r[0] : r[1],
    k < 2 ? r[2] : r[3],
    r[4],
  ];
  const face: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    face.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let ring = 0; ring < 2; ring++) {
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      quad(
        corner(rects[ring], k),
        corner(rects[ring], k1),
        corner(rects[ring + 1], k1),
        corner(rects[ring + 1], k),
      );
    }
  }
  quad(corner(rects[2], 0), corner(rects[2], 1), corner(rects[2], 2), corner(rects[2], 3));
  const positions: number[] = [];
  for (let side = 0; side < 4; side++) {
    const rot = (side * Math.PI) / 2;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    for (let i = 0; i < face.length; i += 3)
      positions.push(face[i] * c + face[i + 2] * sn, face[i + 1], -face[i] * sn + face[i + 2] * c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

function topCap(halfWidth: number, y: number): THREE.BufferGeometry {
  const w = halfWidth;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-w, y, w, w, y, w, w, y, -w, -w, y, w, w, y, -w, -w, y, -w], 3),
  );
  g.computeVertexNormals();
  return g;
}

/** Honed white marble with soft grey veining (object-space procedural, no textures). */
function marbleMaterial(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    metalness: 0,
    specularIntensity: 0.35,
    envMapIntensity: 0.25,
  });
  const p = positionLocal.mul(4);
  const warp = mx_fractal_noise_vec3(p.mul(0.5), 3, 2, 0.5).mul(0.9);
  const q = p.add(warp);
  // Veins follow the zero crossings of fractal noise: irregular, branching lines.
  const main = mx_fractal_noise_float(q.mul(vec3(0.9, 0.55, 0.9)), 5, 2, 0.55);
  const veins = pow(clamp(float(1).sub(abs(main).mul(7)), 0, 1), 4);
  const faint = mx_fractal_noise_float(q.mul(2.3).add(17), 4, 2, 0.5);
  const hairline = pow(clamp(float(1).sub(abs(faint).mul(12)), 0, 1), 6).mul(0.35);
  const vein = clamp(veins.add(hairline), 0, 1);
  const cloud = mx_fractal_noise_float(p.mul(1.1).add(5), 3, 2, 0.5).mul(0.045);
  m.colorNode = mix(color('#e8e4dd').add(cloud), color('#958f86'), vein.mul(0.7));
  m.roughnessNode = mix(float(0.42), float(0.5), vein);
  return m;
}

/**
 * Classical museum pedestal: plinth block with torus and cove mouldings, a die with recessed panels
 * and a cornice, in honed marble. The top sits at y = 0 (local) and the base at y = −height.
 */
export function createPedestal(size: PedestalSize): THREE.Mesh {
  const { s, dieBottom, dieTop } = layout(size);
  const geometry = mergeGeometries([
    squareSweep(BASE, s, 0),
    panelledDie(s, dieBottom, dieTop),
    squareSweep(CORNICE, s, dieTop),
    topCap(CORNICE[CORNICE.length - 1].w * s, size.height),
  ]);
  geometry.translate(0, -size.height, 0);
  const mesh = new THREE.Mesh(geometry, marbleMaterial());
  mesh.name = 'pedestal';
  return mesh;
}
