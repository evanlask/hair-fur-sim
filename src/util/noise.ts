/** Deterministic noise for groom styles (which get no RNG, so they hash positions) and brushes. */

/** Integer lattice hash → [0, 1). */
export function hash2(ix: number, iz: number, seed = 0): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Smooth value noise in [0, 1). */
export function valueNoise2(x: number, z: number, seed = 0): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Integer lattice hash in 3D → [0, 1). */
export function hash3(ix: number, iy: number, iz: number, seed = 0): number {
  let h =
    Math.imul(ix | 0, 0x27d4eb2d) ^
    Math.imul(iy | 0, 0x7feb352d) ^
    Math.imul(iz | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) of a point in space, one lattice cell per unit. */
export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (dz: number) =>
    lerp(
      lerp(hash3(ix, iy, iz + dz, seed), hash3(ix + 1, iy, iz + dz, seed), fx),
      lerp(hash3(ix, iy + 1, iz + dz, seed), hash3(ix + 1, iy + 1, iz + dz, seed), fx),
      fy,
    );
  return lerp(plane(0), plane(1), fz);
}

/** Fractal value noise in [0, 1), normalised over octaves. */
export function fbm2(x: number, z: number, octaves = 3, seed = 0): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2(x, z, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 17.1;
    z = z * 2.03 - 9.7;
  }
  return sum / norm;
}

export interface WorleyResult {
  /** Nearest jittered cell centre. */
  x: number;
  z: number;
  /** Distance to it, in cells (0 at the centre, ~0.7 at the edge). */
  dist: number;
  /** Hash of the nearest cell, in [0, 1). */
  id: number;
}

/** Cellular noise: nearest of the jittered points in a grid of `cell` spacing. */
export function worley2(x: number, z: number, cell: number, seed = 0, out?: WorleyResult): WorleyResult {
  const r = out ?? { x: 0, z: 0, dist: 0, id: 0 };
  const gx = x / cell;
  const gz = z / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  let best = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cz = iz + dz;
      const px = cx + hash2(cx, cz, seed);
      const pz = cz + hash2(cx, cz, seed + 1);
      const d2 = (px - gx) * (px - gx) + (pz - gz) * (pz - gz);
      if (d2 < best) {
        best = d2;
        r.x = px * cell;
        r.z = pz * cell;
        r.id = hash2(cx, cz, seed + 2);
      }
    }
  }
  r.dist = Math.sqrt(best);
  return r;
}
