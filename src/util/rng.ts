/** Small seeded PRNG (mulberry32) — deterministic grooms for a given seed. */
export class Rng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform 32-bit unsigned integer. */
  uint(): number {
    return (this.next() * 4294967296) >>> 0;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

/** Fisher–Yates shuffle of an index permutation. */
export function shuffledIndices(count: number, rng: Rng): Uint32Array {
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  for (let i = count - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  return idx;
}
