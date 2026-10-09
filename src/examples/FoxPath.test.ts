import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { FoxPath, MAX_STAGGER, MAX_WOBBLE } from './FoxPath';

describe('FoxPath', () => {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  it('keeps two foxes apart and never lets them pass each other', () => {
    const rMin = 0.6 * (1 - 1.5 * MAX_WOBBLE);
    const minGap = rMin * Math.sqrt(2 + 2 * Math.cos(MAX_STAGGER));
    for (let seed = 1; seed <= 20; seed++) {
      const path = new FoxPath(seed);
      path.radius = 0.6;
      path.wiggle = 1.5;
      let min = Infinity;
      // Long enough for many stagger cycles, with the shape drifting too.
      for (let i = 0; i < 20000; i++) {
        path.advance(0.05, 1.2, 2);
        const t0 = path.foxAngle(0);
        const t1 = path.foxAngle(1);
        min = Math.min(min, path.point(t0, a).distanceTo(path.point(t1, b)));
        // Fox 1 stays roughly half a lap ahead of fox 0: they never meet on the loop.
        expect(Math.abs(t1 - t0 - Math.PI)).toBeLessThanOrEqual(MAX_STAGGER + 1e-9);
      }
      expect(min).toBeGreaterThanOrEqual(minGap - 1e-9);
    }
  });

  it('lets each fox speed up and slow down only slightly', () => {
    const path = new FoxPath(4);
    path.wiggle = 0; // a circle, so only the stagger changes the speed
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < 20000; i++) {
      path.advance(0.05, 0.62, 2);
      for (const f of [0, 1]) {
        const v = path.stride(path.foxAngle(f)) * path.foxRate(f);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    expect(lo).toBeGreaterThan(0.62 * 0.88);
    expect(hi).toBeLessThan(0.62 * 1.12);
    expect(hi - lo).toBeGreaterThan(0.62 * 0.1); // it does vary
  });

  it('never crosses itself: the radius stays positive in every direction', () => {
    const path = new FoxPath(3);
    path.wiggle = 1.5;
    for (let i = 0; i < 2000; i++) {
      const t = (i / 2000) * Math.PI * 2;
      expect(path.point(t, a).length()).toBeGreaterThan(path.radius * (1 - 1.5 * MAX_WOBBLE) - 1e-9);
    }
  });

  it('is a circle at wiggle 0 and faces along the direction of travel', () => {
    const path = new FoxPath(7);
    path.wiggle = 0;
    path.radius = 2;
    expect(path.point(1.1, a).length()).toBeCloseTo(2, 9);
    expect(path.stride(1.1)).toBeCloseTo(2, 9);
    path.wiggle = 1;
    const t = 0.8;
    const dir = path
      .point(t + 1e-5, b)
      .sub(path.point(t - 1e-5, a))
      .normalize();
    expect(Math.atan2(dir.x, dir.z)).toBeCloseTo(path.heading(t), 4);
  });

  it('advances so the foxes average the requested ground speed', () => {
    const path = new FoxPath(2);
    path.advance(0.1, 0.62, 2);
    const avg = ((path.stride(path.foxAngle(0)) + path.stride(path.foxAngle(1))) / 2) * path.rate;
    expect(avg).toBeCloseTo(0.62, 2);
    path.advance(0.1, 0, 2);
    expect(path.rate).toBe(0);
  });
});
