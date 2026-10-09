/**
 * Procedural, royalty-free metal loop rendered with an OfflineAudioContext:
 * double-tracked distorted power-chord guitars (palm-muted gallops + open hits), bass, and a
 * synthesized drum kit. The beat grid is exact, so motion can lock to it perfectly.
 */

const NOTE: Record<string, number> = {
  E: 82.41,
  F: 87.31,
  G: 98.0,
  A: 110.0,
  Bb: 116.54,
  B: 123.47,
  C: 130.81,
  D: 146.83,
};

interface GuitarHit {
  /** Beat position within the loop. */
  beat: number;
  /** Length in beats. */
  len: number;
  root: number;
  muted: boolean;
  accent?: boolean;
}

interface DrumHit {
  beat: number;
  kind: 'kick' | 'snare' | 'hat' | 'crash' | 'tom';
  pitch?: number;
}

const BARS = 4;

/** 4-bar riff in E minor: gallops on E5, G5/A5 pushes, a tritone (Bb5) stab and a fill. */
function riff(): { guitar: GuitarHit[]; drums: DrumHit[] } {
  const guitar: GuitarHit[] = [];
  const drums: DrumHit[] = [];
  const gallop = (beat: number, root: number) => {
    guitar.push({ beat, len: 0.5, root, muted: true, accent: true });
    guitar.push({ beat: beat + 0.5, len: 0.25, root, muted: true });
    guitar.push({ beat: beat + 0.75, len: 0.25, root, muted: true });
  };
  const open = (beat: number, len: number, root: number) =>
    guitar.push({ beat, len, root, muted: false, accent: true });

  // Bar 1: crash + open E, then gallops.
  open(0, 1, NOTE.E);
  gallop(1, NOTE.E);
  gallop(2, NOTE.E);
  gallop(3, NOTE.E);
  // Bar 2: gallops, then G5 → A5 pushes.
  gallop(4, NOTE.E);
  gallop(5, NOTE.E);
  open(6, 0.75, NOTE.G);
  open(6.75, 1.25, NOTE.A);
  // Bar 3: gallops, tritone stab.
  gallop(8, NOTE.E);
  gallop(9, NOTE.E);
  gallop(10, NOTE.E);
  open(11, 1, NOTE.Bb);
  // Bar 4: chugs then a descending run.
  gallop(12, NOTE.E);
  gallop(13, NOTE.E);
  open(14, 0.5, NOTE.D);
  open(14.5, 0.5, NOTE.C);
  open(15, 0.5, NOTE.B);
  open(15.5, 0.5, NOTE.Bb);

  for (let b = 0; b < BARS * 4; b++) {
    // Kick on 1 and 3 (+ the "and" of 4), snare on 2 and 4 — the classic headbang groove.
    if (b % 2 === 0) drums.push({ beat: b, kind: 'kick' });
    else drums.push({ beat: b, kind: 'snare' });
    drums.push({ beat: b, kind: 'hat' }, { beat: b + 0.5, kind: 'hat' });
    if (b % 4 === 3) drums.push({ beat: b + 0.5, kind: 'kick' });
  }
  // Double-kick 16ths through bar 3.
  for (let s = 8; s < 12; s += 0.25) if (s % 1 !== 0) drums.push({ beat: s, kind: 'kick' });
  drums.push({ beat: 0, kind: 'crash' }, { beat: 8, kind: 'crash' });
  // Tom fill on the last beat.
  drums.push(
    { beat: 15, kind: 'tom', pitch: 140 },
    { beat: 15.25, kind: 'tom', pitch: 115 },
    { beat: 15.5, kind: 'tom', pitch: 95 },
    { beat: 15.75, kind: 'tom', pitch: 80 },
  );
  return { guitar, drums };
}

function distortionCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < d.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    d[i] = (seed / 4294967296) * 2 - 1;
  }
  return buf;
}

/** A guitar amp + cab chain feeding a stereo position. */
function guitarChannel(ctx: BaseAudioContext, out: AudioNode, pan: number): AudioNode {
  const input = ctx.createGain();
  input.gain.value = 1;
  const pre = ctx.createBiquadFilter();
  pre.type = 'highpass';
  pre.frequency.value = 110;
  const drive = ctx.createGain();
  drive.gain.value = 9;
  const shaper = ctx.createWaveShaper();
  shaper.curve = distortionCurve(3.2);
  shaper.oversample = '4x';
  const scoop = ctx.createBiquadFilter();
  scoop.type = 'peaking';
  scoop.frequency.value = 650;
  scoop.Q.value = 0.8;
  scoop.gain.value = -6;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2800;
  presence.Q.value = 1.0;
  presence.gain.value = 4;
  const cab = ctx.createBiquadFilter();
  cab.type = 'lowpass';
  cab.frequency.value = 5200;
  cab.Q.value = 0.7;
  const level = ctx.createGain();
  level.gain.value = 0.16;
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  input
    .connect(pre)
    .connect(drive)
    .connect(shaper)
    .connect(scoop)
    .connect(presence)
    .connect(cab)
    .connect(level)
    .connect(panner)
    .connect(out);
  return input;
}

/** Renders the seamless 4-bar loop at `bpm`. Beat 0 is at time 0 of the buffer. */
export async function renderMetalLoop(
  bpm: number,
  sampleRate = 44100,
): Promise<{ buffer: AudioBuffer; beats: number }> {
  const spb = 60 / bpm;
  const beats = BARS * 4;
  const loopLen = beats * spb;
  const tail = 1.6;
  const ctx = new OfflineAudioContext(2, Math.ceil((loopLen + tail) * sampleRate), sampleRate);

  const master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.15;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.6;
  master.connect(comp).connect(makeup).connect(ctx.destination);

  const { guitar, drums } = riff();
  const guitarL = guitarChannel(ctx, master, -0.75);
  const guitarR = guitarChannel(ctx, master, 0.75);

  // Power chord (root, fifth, octave), double-tracked with slight detune and timing offsets.
  const chord = [1, 1.4983, 2];
  for (const [side, bus, detune, late] of [
    [0, guitarL, -6, 0],
    [1, guitarR, 7, 0.006],
  ] as const) {
    for (const h of guitar) {
      const t0 = h.beat * spb + late + side * 0.002;
      const dur = h.len * spb * (h.muted ? 0.82 : 0.96);
      const env = ctx.createGain();
      const peak = h.accent ? 1 : 0.8;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      if (h.muted) env.gain.exponentialRampToValueAtTime(0.08, t0 + Math.min(dur, 0.13));
      else env.gain.setTargetAtTime(peak * 0.7, t0 + 0.05, 0.4);
      env.gain.setTargetAtTime(0, t0 + dur, 0.025);
      // Palm muting = low-passing before the distortion.
      const mute = ctx.createBiquadFilter();
      mute.type = 'lowpass';
      mute.frequency.value = h.muted ? 700 : 4500;
      mute.Q.value = 0.9;
      env.connect(mute).connect(bus);
      for (const ratio of chord) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = h.root * ratio;
        osc.detune.value = detune + (ratio === 2 ? 3 : 0);
        osc.connect(env);
        osc.start(t0);
        osc.stop(t0 + dur + 0.2);
      }
    }
  }

  const bassBus = ctx.createBiquadFilter();
  bassBus.type = 'lowpass';
  bassBus.frequency.value = 420;
  const bassLevel = ctx.createGain();
  bassLevel.gain.value = 0.22;
  bassBus.connect(bassLevel).connect(master);
  for (const h of guitar) {
    const t0 = h.beat * spb;
    const dur = h.len * spb * 0.9;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = h.root / 2;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.005);
    env.gain.setTargetAtTime(0, t0 + dur, 0.03);
    osc.connect(env).connect(bassBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.2);
  }

  const noise = noiseBuffer(ctx, 2);
  const playNoise = (
    t0: number,
    dur: number,
    filterType: BiquadFilterType,
    freq: number,
    q: number,
    gain: number,
    decay: number,
  ) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    // Looped, so long hits (the 2.2 s crash) never run out of buffer after the random start offset.
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.setTargetAtTime(0, t0 + 0.002, decay);
    src.connect(f).connect(env).connect(master);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur);
  };
  for (const d of drums) {
    const t0 = d.beat * spb;
    switch (d.kind) {
      case 'kick': {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, t0);
        osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.07);
        const env = ctx.createGain();
        env.gain.setValueAtTime(1.1, t0);
        env.gain.setTargetAtTime(0, t0 + 0.01, 0.09);
        osc.connect(env).connect(master);
        osc.start(t0);
        osc.stop(t0 + 0.5);
        playNoise(t0, 0.03, 'highpass', 3000, 0.7, 0.25, 0.006); // beater click
        break;
      }
      case 'snare': {
        playNoise(t0, 0.35, 'bandpass', 1900, 0.6, 0.75, 0.07);
        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(220, t0);
        body.frequency.exponentialRampToValueAtTime(170, t0 + 0.05);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.5, t0);
        env.gain.setTargetAtTime(0, t0 + 0.005, 0.05);
        body.connect(env).connect(master);
        body.start(t0);
        body.stop(t0 + 0.3);
        break;
      }
      case 'hat':
        playNoise(t0, 0.08, 'highpass', 8000, 0.7, 0.18, 0.018);
        break;
      case 'crash':
        playNoise(t0, 2.2, 'highpass', 4500, 0.5, 0.35, 0.45);
        break;
      case 'tom': {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const p = d.pitch ?? 110;
        osc.frequency.setValueAtTime(p * 1.4, t0);
        osc.frequency.exponentialRampToValueAtTime(p, t0 + 0.05);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.9, t0);
        env.gain.setTargetAtTime(0, t0 + 0.01, 0.12);
        osc.connect(env).connect(master);
        osc.start(t0);
        osc.stop(t0 + 0.6);
        break;
      }
    }
  }

  const rendered = await ctx.startRendering();
  // Fold the tail (ringing past the loop end) back onto the start for a seamless loop.
  const loopFrames = Math.round(loopLen * sampleRate);
  const out = new AudioBuffer({ numberOfChannels: 2, length: loopFrames, sampleRate });
  for (let c = 0; c < 2; c++) {
    const src = rendered.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, loopFrames));
    for (let i = loopFrames; i < src.length; i++) dst[i - loopFrames] += src[i];
  }
  return { buffer: out, beats };
}
