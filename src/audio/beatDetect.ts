/**
 * Tempo + beat-phase detection for arbitrary music (pure functions, testable without Web Audio). Not used at
 * runtime: the tempos and offsets in library.ts were precomputed with it.
 *
 * 1. Onset envelope: positive log-energy flux of a low band (kick) and the full band, per hop.
 * 2. Coarse tempo: autocorrelation of the envelope over 70–180 BPM with a prior around 120 BPM.
 * 3. Phase: comb search for the offset whose beat grid collects the most onset energy.
 * 4. Refinement: snap each predicted beat to the nearest onset peak and fit time = offset + k·period
 *    by least squares over the whole track (precise enough to stay locked for minutes).
 */

export interface BeatAnalysis {
  bpm: number;
  /** Time (s) of a beat; beats occur at offset + k · 60 / bpm. */
  offset: number;
  /** 0..1 rough confidence. */
  confidence: number;
}

export interface OnsetEnvelope {
  env: Float32Array;
  frameRate: number;
}

/** In-place biquad low-pass (RBJ cookbook). */
function biquadLowpass(x: Float32Array, sampleRate: number, cutoff: number, q: number): void {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

/**
 * Mixes channels to mono and resamples to exactly `targetRate` (4th-order Butterworth anti-aliasing low-pass +
 * linear interpolation), so analysis is identical for 44.1 / 48 kHz input. Input already at or below
 * `targetRate` is returned at its own rate.
 */
export function mixdown(
  channels: Float32Array[],
  sampleRate: number,
  targetRate = 11025,
): { samples: Float32Array; sampleRate: number } {
  const len = channels[0].length;
  const mono = new Float32Array(len);
  const inv = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] * inv;
  if (sampleRate <= targetRate * 1.01) return { samples: mono, sampleRate };
  const cutoff = 0.45 * targetRate;
  // Two cascaded sections with the Butterworth Qs for 4th order.
  biquadLowpass(mono, sampleRate, cutoff, 0.5412);
  biquadLowpass(mono, sampleRate, cutoff, 1.3066);
  const step = sampleRate / targetRate;
  const n = Math.floor((len - 1) / step);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const f = x - i0;
    out[i] = mono[i0] * (1 - f) + mono[i0 + 1] * f;
  }
  return { samples: out, sampleRate: targetRate };
}

/** Onset strength per hop: low-band (one-pole low-pass ~150 Hz) and full-band log-energy flux. */
export function onsetEnvelope(samples: Float32Array, sampleRate: number, hopSeconds = 0.005): OnsetEnvelope {
  const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  const a = Math.exp((-2 * Math.PI * 150) / sampleRate);
  let lp = 0;
  let prevLow = 0;
  let prevFull = 0;
  for (let f = 0; f < frames; f++) {
    let eLow = 0;
    let eFull = 0;
    const base = f * hop;
    for (let k = 0; k < hop; k++) {
      const x = samples[base + k];
      lp = a * lp + (1 - a) * x;
      eLow += lp * lp;
      eFull += x * x;
    }
    const lLow = Math.log(1e-9 + eLow);
    const lFull = Math.log(1e-9 + eFull);
    env[f] = Math.max(0, lLow - prevLow) + 0.5 * Math.max(0, lFull - prevFull);
    prevLow = lLow;
    prevFull = lFull;
  }
  // Remove a slow moving average so sustained loudness doesn't dominate.
  const w = Math.round(0.25 / hopSeconds);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += env[f];
    if (f >= w) acc -= env[f - w];
    out[f] = Math.max(0, env[f] - acc / Math.min(f + 1, w));
  }
  // Exact frame rate of the rounded hop (using 1/hopSeconds would skew the tempo by the rounding error).
  return { env: out, frameRate: sampleRate / hop };
}

/** Coarse tempo from the envelope autocorrelation, weighted by a log-normal prior around 120 BPM. */
export function estimateTempo(
  o: OnsetEnvelope,
  minBpm = 70,
  maxBpm = 180,
): { bpm: number; confidence: number } {
  const { env, frameRate } = o;
  const minLag = Math.floor((60 / maxBpm) * frameRate);
  const maxLag = Math.ceil((60 / minBpm) * frameRate);
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac[lag] = s / Math.max(1, n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  let total = 0;
  // Autocorrelation at a fractional lag, sampling every 3rd frame: cheap enough for the 2× and 4× harmonic lags.
  const acAt = (l: number) => {
    const i = Math.floor(l);
    if (i < 0 || i + 1 >= n) return 0;
    let s1 = 0;
    let s2 = 0;
    for (let k = 0; k + i + 1 < n; k += 3) {
      s1 += (env[k] - mean) * (env[k + i] - mean);
      s2 += (env[k] - mean) * (env[k + i + 1] - mean);
    }
    return s1 + (s2 - s1) * (l - i);
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    // Harmonic summation: a true beat period also correlates at 2× and 4× (bars), which favours
    // the metrical level consistent with the bar structure.
    const harmonic = (acAt(lag * 2) + 0.5 * acAt(lag * 4)) / Math.max(1, n / 3);
    const score = (ac[lag] + 0.5 * harmonic) * prior;
    total += Math.max(0, ac[lag]);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic interpolation around the peak.
  const y0 = ac[best - 1];
  const y1 = ac[best];
  const y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const lag = best + shift;
  const confidence = total > 0 ? Math.min(1, (Math.max(0, y1) * (maxLag - minLag + 1)) / total / 8) : 0;
  return { bpm: (60 * frameRate) / lag, confidence };
}

function sampleEnv(env: Float32Array, x: number): number {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= env.length) return 0;
  const f = x - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

/** Offset (s) in [0, period) whose beat grid collects the most onset energy. */
export function estimatePhase(o: OnsetEnvelope, bpm: number): number {
  const { env, frameRate } = o;
  const period = (60 / bpm) * frameRate;
  const steps = Math.max(8, Math.round(period));
  let best = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const p = (s / steps) * period;
    let score = 0;
    for (let x = p; x < env.length; x += period)
      score += sampleEnv(env, x) + 0.5 * (sampleEnv(env, x - 1) + sampleEnv(env, x + 1));
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best / frameRate;
}

/**
 * Snaps predicted beats to local onset peaks and least-squares fits time = offset + k · period.
 * Returns the refined bpm/offset (iterate a couple of times for best results).
 */
export function refineBeats(
  o: OnsetEnvelope,
  bpm: number,
  offset: number,
  maxTime = Infinity,
): { bpm: number; offset: number } {
  const { env, frameRate } = o;
  const period = 60 / bpm;
  const win = period * 0.18;
  const ks: number[] = [];
  const ts: number[] = [];
  const duration = Math.min(maxTime, env.length / frameRate);
  for (let k = 0; offset + k * period < duration; k++) {
    const t = offset + k * period;
    const lo = Math.max(0, Math.floor((t - win) * frameRate));
    const hi = Math.min(env.length - 1, Math.ceil((t + win) * frameRate));
    let bi = -1;
    let bv = 0;
    for (let i = lo; i <= hi; i++) {
      if (env[i] > bv) {
        bv = env[i];
        bi = i;
      }
    }
    if (bi < 0 || bv <= 0) continue;
    // Sub-frame peak position.
    const y0 = env[bi - 1] ?? 0;
    const y2 = env[bi + 1] ?? 0;
    const d = y0 - 2 * bv + y2;
    const shift = Math.abs(d) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;
    ks.push(k);
    ts.push((bi + shift) / frameRate);
  }
  if (ks.length < 8) return { bpm, offset };
  // Robust-ish fit: least squares, then drop the worst 20% residuals and refit.
  const fit = (idx: number[]) => {
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (const i of idx) {
      sk += ks[i];
      st += ts[i];
      skk += ks[i] * ks[i];
      skt += ks[i] * ts[i];
    }
    const m = idx.length;
    const slope = (m * skt - sk * st) / Math.max(1e-12, m * skk - sk * sk);
    const icpt = (st - slope * sk) / m;
    return { slope, icpt };
  };
  let idx = ks.map((_, i) => i);
  let { slope, icpt } = fit(idx);
  const res = idx.map((i) => Math.abs(ts[i] - (icpt + slope * ks[i])));
  const cut = [...res].sort((a, b) => a - b)[Math.floor(res.length * 0.8)];
  idx = idx.filter((_, j) => res[j] <= cut);
  ({ slope, icpt } = fit(idx));
  if (!(slope > 0)) return { bpm, offset };
  const p = slope;
  return { bpm: 60 / p, offset: ((icpt % p) + p) % p };
}

/**
 * Full analysis of mono samples. `bpmHint` (optional) restricts the tempo search to ±3% around it,
 * for tracks whose strongest periodicity isn't the pulse you want to move to.
 */
export function analyzeSamples(samples: Float32Array, sampleRate: number, bpmHint?: number): BeatAnalysis {
  const o = onsetEnvelope(samples, sampleRate);
  const { bpm: coarse, confidence } = bpmHint
    ? estimateTempo(o, bpmHint * 0.97, bpmHint * 1.03)
    : estimateTempo(o);
  const duration = o.env.length / o.frameRate;
  let bpm = coarse;
  let offset = estimatePhase(o, bpm);
  // Refine over a growing span so a slightly-off coarse tempo never drifts beats out of the
  // snapping window before it gets corrected.
  for (const span of [0.15, 0.3, 0.6, 1, 1])
    ({ bpm, offset } = refineBeats(o, bpm, offset, Math.max(8 * (60 / bpm), duration * span)));
  // Polish: produced music usually sits on a round tempo — prefer it when it aligns at least as well.
  let best = { bpm, offset, score: combScore(o, bpm, offset) };
  for (const cand of [Math.round(bpm), Math.round(bpm * 2) / 2]) {
    if (Math.abs(cand - bpm) / bpm > 0.004) continue;
    const off = estimatePhase(o, cand);
    const refined = refineBeats(o, cand, off);
    const score = combScore(o, cand, refined.offset);
    if (score >= best.score * 0.995) best = { bpm: cand, offset: refined.offset, score };
  }
  return { bpm: best.bpm, offset: best.offset, confidence };
}

/** Mean onset strength collected by a beat grid over the whole track (alignment quality). */
export function combScore(o: OnsetEnvelope, bpm: number, offset: number): number {
  const period = (60 / bpm) * o.frameRate;
  let score = 0;
  let n = 0;
  for (let x = offset * o.frameRate; x < o.env.length; x += period) {
    score += Math.max(sampleEnv(o.env, x - 1), sampleEnv(o.env, x), sampleEnv(o.env, x + 1));
    n++;
  }
  return n ? score / n : 0;
}
