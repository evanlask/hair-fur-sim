import { describe, expect, it } from 'vite-plus/test';

import { BeatFollower } from './beatFollower';

const DT = 1 / 60;

/** Runs `seconds` of frames; returns the largest single-frame step. */
function run(f: BeatFollower, seconds: number, rate: number, target?: (t: number) => number, t0 = 0) {
  let maxStep = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = f.beat;
    f.update(DT, rate, target ? target(t0 + (i + 1) * DT) : null);
    maxStep = Math.max(maxStep, f.beat - before);
  }
  return maxStep;
}

/** Phase difference to the nearest beat, in [-0.5, 0.5]. */
const phaseError = (a: number, b: number) => a - b - Math.round(a - b);

describe('BeatFollower', () => {
  it('free-runs at the given tempo and changes speed, not position, when the tempo changes', () => {
    const f = new BeatFollower();
    run(f, 10, 2);
    expect(f.beat).toBeCloseTo(20, 6);
    const before = f.beat;
    f.update(DT, 2.2);
    expect(f.beat - before).toBeCloseTo(2.2 * DT, 9);
  });

  it('locks onto a reference beat from any starting phase within about a second', () => {
    for (const start of [0, 0.2, 0.45, 0.55, 0.8]) {
      const f = new BeatFollower();
      f.beat = start;
      const music = (t: number) => t * 2;
      run(f, 1.2, 2, music);
      expect(Math.abs(phaseError(f.beat, music(1.2)))).toBeLessThan(0.02);
      run(f, 2, 2, music, 1.2);
      expect(Math.abs(phaseError(f.beat, music(3.2)))).toBeLessThan(1e-3);
    }
  });

  it('eases onto a jumped reference (a BPM edit mid-song) without ever jumping or going backwards', () => {
    const f = new BeatFollower();
    // 30 s into a song at 120 BPM, then the BPM is nudged to 121: the reference beat jumps by half a beat.
    const before = (t: number) => (t * 120) / 60;
    const after = (t: number) => (t * 121) / 60;
    run(f, 30, 2, before);
    const rate = 121 / 60;
    let minStep = Infinity;
    let maxStep = 0;
    for (let i = 1; i <= 90; i++) {
      const prev = f.beat;
      f.update(DT, rate, after(30 + i * DT));
      minStep = Math.min(minStep, f.beat - prev);
      maxStep = Math.max(maxStep, f.beat - prev);
    }
    expect(minStep).toBeGreaterThanOrEqual(rate * 0.25 * DT - 1e-9);
    expect(maxStep).toBeLessThanOrEqual(rate * 2 * DT + 1e-9);
    expect(Math.abs(phaseError(f.beat, after(31.5)))).toBeLessThan(0.02);
  });

  it('takes the nearest beat: a reference just behind slows it down rather than racing a whole beat ahead', () => {
    const f = new BeatFollower();
    f.beat = 0.1;
    const before = f.beat;
    f.update(DT, 2, 0); // reference beat is 0.1 behind
    expect(f.beat - before).toBeLessThan(2 * DT);
    expect(f.beat - before).toBeGreaterThan(0);
  });
});
