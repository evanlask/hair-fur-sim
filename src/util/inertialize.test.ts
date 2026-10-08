import { describe, expect, it } from 'vite-plus/test';

import { Inertializer } from './inertialize';

const DT = 1 / 60;
const fast = (t: number) => Math.sin(t * 8); // a motion moving quickly...
const other = (t: number) => 0.5 + 0.2 * Math.cos(t * 3); // ...switched to one somewhere else entirely

/** Runs the inertializer over [t0, t1), switching from `a` to `b` at `switchAt`; returns the output per frame. */
function run(a: (t: number) => number, b: (t: number) => number, switchAt: number, t1: number) {
  const inert = new Inertializer(1);
  const out: number[] = [];
  for (let f = 0; f * DT < t1; f++) {
    const t = f * DT;
    const switching = Math.abs(t - switchAt) < DT / 2;
    const motion = t < switchAt - DT / 2 ? a : b;
    out.push(inert.update(DT, [motion(t)], switching ? [b(t - DT)] : undefined)[0]);
  }
  return out;
}

describe('Inertializer', () => {
  it('follows the target exactly when nothing switches', () => {
    const out = run(fast, fast, -1, 2);
    out.forEach((v, f) => expect(v).toBeCloseTo(fast(f * DT), 9));
  });

  it('carries position and velocity through a switch: no jump and no stall', () => {
    const out = run(fast, other, 1, 2);
    const s = Math.round(1 / DT);
    const velocity = (f: number) => (out[f] - out[f - 1]) / DT;
    // The frame of the switch moves on at the old motion's speed, not towards the new pose.
    expect(velocity(s)).toBeCloseTo(velocity(s - 1), 0);
    // Velocity then changes gradually: a kink would drop it by ~8 (the old motion's speed) in one frame, while
    // fast() alone changes it by up to 64·DT ≈ 1.1 per frame.
    for (let f = s; f < s + 30; f++) expect(Math.abs(velocity(f + 1) - velocity(f))).toBeLessThan(2);
  });

  it('settles on the new target within about half a second', () => {
    const out = run(fast, other, 1, 2);
    const f = Math.round(1.6 / DT);
    expect(Math.abs(out[f] - other(f * DT))).toBeLessThan(0.01);
  });

  it('stays continuous when switched again mid-transition', () => {
    const inert = new Inertializer(1);
    const motions = [fast, other, fast];
    let prev = 0;
    let maxStep = 0;
    for (let f = 0; f < 120; f++) {
      const t = f * DT;
      const m = motions[f < 30 ? 0 : f < 40 ? 1 : 2];
      const switching = f === 30 || f === 40;
      const v = inert.update(DT, [m(t)], switching ? [m(t - DT)] : undefined)[0];
      if (f > 0) maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    // fast() moves up to 8·DT ≈ 0.13 per frame; snapping between the motions would step by up to ~1.
    expect(maxStep).toBeLessThan(1.5 * 8 * DT);
  });
});
