import { describe, expect, it } from 'vite-plus/test';

import { fbm2, hash2, valueNoise2, worley2 } from './noise';

describe('noise', () => {
  it('is deterministic and stays in [0, 1)', () => {
    for (let i = 0; i < 500; i++) {
      const x = (i * 0.737) % 13;
      const z = (i * 1.913) % 7;
      for (const f of [hash2(i, i * 3, 2), valueNoise2(x, z, 4), fbm2(x, z, 3, 1)]) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThan(1);
      }
      expect(valueNoise2(x, z, 4)).toBe(valueNoise2(x, z, 4));
      expect(fbm2(x, z, 3, 1)).toBe(fbm2(x, z, 3, 1));
    }
  });

  it('value noise is continuous', () => {
    for (let i = 0; i < 100; i++) {
      const x = i * 0.31;
      expect(Math.abs(valueNoise2(x, 0.5) - valueNoise2(x + 1e-4, 0.5))).toBeLessThan(1e-2);
    }
  });

  it('worley returns the nearest jittered cell centre', () => {
    const r = worley2(0.37, -1.21, 0.2, 3);
    expect(Math.hypot(r.x - 0.37, r.z + 1.21) / 0.2).toBeCloseTo(r.dist, 6);
    // No other cell centre is nearer.
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const cx = Math.floor(0.37 / 0.2) + dx;
        const cz = Math.floor(-1.21 / 0.2) + dz;
        const px = (cx + hash2(cx, cz, 3)) * 0.2;
        const pz = (cz + hash2(cx, cz, 4)) * 0.2;
        expect(Math.hypot(px - 0.37, pz + 1.21) / 0.2).toBeGreaterThanOrEqual(r.dist - 1e-9);
      }
    }
  });
});
