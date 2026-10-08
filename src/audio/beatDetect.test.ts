import { describe, expect, it } from 'vite-plus/test';

import { analyzeSamples, estimateTempo, mixdown, onsetEnvelope } from './beatDetect';

/** Synthetic "four on the floor" track: decaying 60 Hz kicks + hats + noise. */
function kickTrack(bpm: number, offset: number, seconds: number, sampleRate = 11025): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  const period = 60 / bpm;
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < out.length; i++) out[i] = rand() * 0.02;
  for (let t = offset; t < seconds; t += period) {
    const start = Math.floor(t * sampleRate);
    for (let k = 0; k < sampleRate * 0.25 && start + k < out.length; k++) {
      const tt = k / sampleRate;
      out[start + k] +=
        Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-tt * 40)) * tt) * Math.exp(-tt * 12) * 0.8;
    }
    // Off-beat hat.
    const hat = Math.floor((t + period / 2) * sampleRate);
    for (let k = 0; k < sampleRate * 0.03 && hat + k < out.length; k++)
      out[hat + k] += rand() * 0.3 * Math.exp(-k / (sampleRate * 0.008));
  }
  return out;
}

const phaseError = (offset: number, expected: number, bpm: number) => {
  const p = 60 / bpm;
  const d = (((offset - expected) % p) + p) % p;
  return Math.min(d, p - d);
};

describe('beat detection', () => {
  it('finds tempo and phase of a 124 BPM track (What Is Love tempo)', () => {
    const sr = 11025;
    const samples = kickTrack(124, 0.21, 40, sr);
    const r = analyzeSamples(samples, sr);
    expect(r.bpm).toBeGreaterThan(123.9);
    expect(r.bpm).toBeLessThan(124.1);
    expect(phaseError(r.offset, 0.21, 124)).toBeLessThan(0.015);
  });

  it('handles a faster metal tempo and stays phase-locked across the whole track', () => {
    const sr = 11025;
    const samples = kickTrack(140, 0.05, 60, sr);
    const r = analyzeSamples(samples, sr);
    expect(Math.abs(r.bpm - 140)).toBeLessThan(0.1);
    // Phase drift (in beats) accumulated over 30 beats must stay small.
    const drift = Math.abs(30 * (60 / r.bpm - 60 / 140) * (140 / 60));
    expect(drift).toBeLessThan(0.02);
  });

  it('coarse tempo prefers the musically plausible octave', () => {
    const sr = 11025;
    const o = onsetEnvelope(kickTrack(124, 0, 20, sr), sr);
    const { bpm } = estimateTempo(o);
    expect(Math.abs(bpm - 124)).toBeLessThan(2);
  });

  it('locks to a hinted tempo when the strongest periodicity is a different pulse', () => {
    const sr = 11025;
    const samples = kickTrack(80, 0.2, 40, sr);
    const r = analyzeSamples(samples, sr, 80);
    expect(Math.abs(r.bpm - 80)).toBeLessThan(0.1);
    expect(phaseError(r.offset, 0.2, 80)).toBeLessThan(0.02);
  });

  it('mixes stereo down and decimates', () => {
    const a = new Float32Array(44100).fill(1);
    const b = new Float32Array(44100).fill(0);
    const m = mixdown([a, b], 44100, 11025);
    expect(m.sampleRate).toBe(11025);
    expect(Math.abs(m.samples.length - 11025)).toBeLessThanOrEqual(1);
    expect(m.samples[100]).toBeCloseTo(0.5);
  });
});
