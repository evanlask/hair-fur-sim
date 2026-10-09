import { METAL_RIFF, MUSIC_LIBRARY, trackLabel } from './library';
import { renderMetalLoop } from './metalSynth';

/** 'metal' (the synthesized riff) or a library track id. */
export type MusicSource = string;

/** Tempo limits (BPM) for the synthesized riff and for track beat grids. */
export const METAL_BPM_RANGE = [50, 220] as const;
export const TRACK_BPM_RANGE = [40, 240] as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** A track's beat grid; tempo edits live here so they survive the decoded audio being dropped. */
interface BeatGrid {
  bpm: number;
  offset: number;
  /** Grid to return to with "Reset beat grid". */
  defaultBpm: number;
  defaultOffset: number;
}

/** What the playing node is playing (may lag the selected source while a new track loads). */
interface Playing {
  source: MusicSource;
  buffer: AudioBuffer;
  /** Riff tempo the buffer was rendered at. */
  metalBpm: number;
}

/**
 * Plays the synthesized metal riff or a bundled track, and exposes a beat clock: the continuous beat
 * count of what is *currently heard* (output latency compensated).
 */
export class MusicPlayer {
  source: MusicSource = MUSIC_LIBRARY[0].id;
  metalBpm = 132;
  volume = 0.7;
  /** Manual sync nudge in milliseconds (+ = visuals later). */
  syncOffsetMs = 0;
  status = 'stopped';
  /** Smoothed loudness 0..~1 of what's playing. */
  level = 0;

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private node: AudioBufferSourceNode | null = null;
  private startTime = 0;
  private current: Playing | null = null;
  private metal: { buffer: AudioBuffer; bpm: number } | null = null;
  private readonly grids = new Map<string, BeatGrid>();
  /** Only the most recently decoded track is kept (a decoded song is ~80 MB of PCM). */
  private decoded: { id: string; buffer: AudioBuffer } | null = null;
  private readonly loading = new Map<string, Promise<AudioBuffer>>();
  private levelData: Float32Array<ArrayBuffer> | null = null;
  private taps: number[] = [];
  /** Pending riff re-render from tap tempo (waits until the taps stop). */
  private tapTimer: ReturnType<typeof setTimeout> | undefined;
  private playToken = 0;
  private starting = false;

  get playing(): boolean {
    return this.node !== null;
  }

  /** True while play() is loading or rendering, before anything is heard. */
  get pending(): boolean {
    return this.starting;
  }

  /** Beat grid of the selected non-metal source (available before its audio has loaded). */
  get track(): BeatGrid | null {
    return this.gridFor(this.source);
  }

  get bpm(): number {
    return this.source === 'metal' ? this.metalBpm : (this.track?.bpm ?? 0);
  }

  get trackName(): string {
    return this.nameOf(this.source);
  }

  /** Name and tempo of what is heard right now, e.g. for a HUD. */
  get nowPlaying(): { name: string; bpm: number; metal: boolean } | null {
    const c = this.current;
    if (!c || !this.node) return null;
    const metal = c.source === 'metal';
    return {
      name: this.nameOf(c.source),
      bpm: metal ? c.metalBpm : (this.gridFor(c.source)?.bpm ?? 0),
      metal,
    };
  }

  private nameOf(source: MusicSource): string {
    const entry = source === 'metal' ? METAL_RIFF : MUSIC_LIBRARY.find((t) => t.id === source);
    return entry ? trackLabel(entry) : source;
  }

  private gridFor(source: MusicSource): BeatGrid | null {
    if (source === 'metal') return null;
    let g = this.grids.get(source);
    if (!g) {
      const entry = MUSIC_LIBRARY.find((t) => t.id === source);
      if (!entry) return null;
      g = { bpm: entry.bpm, offset: entry.offset, defaultBpm: entry.bpm, defaultOffset: entry.offset };
      this.grids.set(source, g);
    }
    return g;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.levelData = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.gain.connect(this.analyser).connect(this.ctx.destination);
    }
    this.gain!.gain.value = this.volume;
    return this.ctx;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  private async metalBuffer(): Promise<{ buffer: AudioBuffer; bpm: number }> {
    if (this.metal && this.metal.bpm === this.metalBpm) return this.metal;
    const bpm = this.metalBpm;
    this.status = `rendering ${trackLabel(METAL_RIFF)}…`;
    const r = await renderMetalLoop(bpm, this.ensureContext().sampleRate);
    this.metal = { buffer: r.buffer, bpm };
    return this.metal;
  }

  /** Fetches + decodes a bundled track (only the latest one stays cached). */
  private loadLibraryTrack(id: string): Promise<AudioBuffer> {
    if (this.decoded?.id === id) return Promise.resolve(this.decoded.buffer);
    let p = this.loading.get(id);
    if (!p) {
      const entry = MUSIC_LIBRARY.find((t) => t.id === id);
      if (!entry) return Promise.reject(new Error(`unknown track ${id}`));
      const ctx = this.ensureContext();
      this.status = `loading ${trackLabel(entry)}…`;
      p = fetch(entry.url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} for ${entry.url}`);
          return r.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          this.decoded = { id, buffer };
          return buffer;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /**
   * Switches source. If something is playing (or about to), playback restarts with the new source;
   * resolves true once it's heard.
   */
  async setSource(source: MusicSource): Promise<boolean> {
    this.source = source;
    if (this.playing || this.starting) return this.play();
    this.status = 'stopped';
    return false;
  }

  /**
   * Starts (or restarts) playback of the current source. Must be called from a user gesture. Resolves
   * true if this call's audio started (false if it failed or a newer play()/stop() superseded it).
   */
  async play(): Promise<boolean> {
    const token = ++this.playToken;
    this.starting = true;
    // Create and resume the context before the first await, while still inside the user gesture (autoplay policy).
    const ctx = this.ensureContext();
    try {
      await ctx.resume();
    } catch (err) {
      if (token === this.playToken) {
        this.starting = false;
        this.status = `could not start audio: ${String(err)}`;
      }
      return false;
    }
    const source = this.source;
    let buffer: AudioBuffer;
    let metalBpm = this.metalBpm;
    try {
      if (source === 'metal') ({ buffer, bpm: metalBpm } = await this.metalBuffer());
      else buffer = await this.loadLibraryTrack(source);
    } catch (err) {
      if (token !== this.playToken) return false;
      // Don't leave the previous track playing under the failed track's name and beat grid.
      this.stopNode();
      this.starting = false;
      this.status = `could not load: ${String(err)}`;
      return false;
    }
    if (token !== this.playToken) return false; // superseded by a newer play() or stop()
    this.starting = false;
    this.stopNode();
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(this.gain!);
    // Scheduled slightly ahead so playback starts exactly at startTime, which the beat clock counts from.
    this.startTime = ctx.currentTime + 0.06;
    node.start(this.startTime);
    this.node = node;
    this.current = { source, buffer, metalBpm };
    this.status = `playing ${this.trackName} · ${this.bpm.toFixed(source === 'metal' ? 0 : 1)} BPM`;
    return true;
  }

  stop(): void {
    this.playToken++;
    this.starting = false;
    this.stopNode();
    this.status = 'stopped';
  }

  private stopNode(): void {
    if (this.node) {
      try {
        this.node.stop();
      } catch {
        // already stopped
      }
      this.node.disconnect();
      this.node = null;
    }
    this.current = null;
  }

  /** Changes the metal tempo; re-renders and restarts if it's playing. */
  async setMetalBpm(bpm: number): Promise<void> {
    this.metalBpm = Math.round(clamp(bpm, METAL_BPM_RANGE));
    if ((this.playing || this.starting) && this.source === 'metal') await this.play();
  }

  /** Overrides the current (non-metal) track's tempo. */
  setTrackBpm(bpm: number): void {
    const t = this.track;
    if (t) t.bpm = clamp(bpm, TRACK_BPM_RANGE);
  }

  /** Song position (s) of what is heard right now, or null when stopped. */
  private songPosition(): number | null {
    if (!this.ctx || !this.node || !this.current) return null;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const t = this.ctx.currentTime - this.startTime - latency - this.syncOffsetMs / 1000;
    if (t < 0) return null;
    return t % this.current.buffer.duration;
  }

  /** Continuous beat count of the audio currently heard, or null when not playing. */
  beat(): number | null {
    // Follows the audio actually heard: while a new track loads or the riff re-renders at a new tempo,
    // the old buffer is still playing.
    const pos = this.songPosition();
    const c = this.current;
    if (pos === null || !c) return null;
    if (c.source === 'metal') return (pos * c.metalBpm) / 60;
    const t = this.gridFor(c.source);
    if (!t) return null;
    return ((pos - t.offset) * t.bpm) / 60;
  }

  /** Updates the loudness meter (call once per frame). */
  updateLevel(dt: number): void {
    if (!this.analyser || !this.levelData || !this.playing) {
      this.level *= Math.exp(-dt * 4);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.levelData);
    let s = 0;
    for (let i = 0; i < this.levelData.length; i++) s += this.levelData[i] * this.levelData[i];
    // Divided by volume so the meter follows the music, not the volume slider.
    const rms = Math.sqrt(s / this.levelData.length) / Math.max(0.05, this.volume);
    const target = Math.min(1.2, rms * 3.5);
    const k = 1 - Math.exp(-dt * (target > this.level ? 20 : 3));
    this.level += (target - this.level) * k;
  }

  /** Restores the current track's precomputed beat grid. */
  resetBeatGrid(): void {
    const t = this.track;
    if (!t) return;
    t.bpm = t.defaultBpm;
    t.offset = t.defaultOffset;
  }

  /** Multiplies the tempo by `factor` (clamped). Re-renders the riff, or keeps a track's beat offset. */
  scaleTempo(factor: number): void {
    if (this.source === 'metal') {
      void this.setMetalBpm(this.metalBpm * factor);
      return;
    }
    this.setTrackBpm((this.track?.bpm ?? 0) * factor);
  }

  /**
   * Tap tempo: tap on the beat. After 4+ taps the tempo is set from the median interval; every tap
   * also aligns the beat phase of tracks so the tap lands on a beat.
   */
  tap(): void {
    const now = performance.now() / 1000;
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 12) this.taps.shift();
    const t = this.track;
    if (this.taps.length >= 4) {
      const iv = this.taps
        .slice(1)
        .map((x, i) => x - this.taps[i])
        .sort((a, b) => a - b);
      const bpm = 60 / iv[Math.floor(iv.length / 2)];
      if (this.source === 'metal') {
        // The tempo shows right away, but re-rendering restarts the riff, which would throw off the remaining
        // taps: wait until tapping stops, and skip it if the riff heard already has this tempo.
        this.metalBpm = Math.round(clamp(bpm, METAL_BPM_RANGE));
        clearTimeout(this.tapTimer);
        this.tapTimer = setTimeout(() => {
          const playing = (this.playing || this.starting) && this.source === 'metal';
          if (playing && this.current?.metalBpm !== this.metalBpm) void this.play();
        }, 1000);
      } else {
        this.setTrackBpm(bpm);
      }
    }
    // Phase alignment only makes sense against the selected track's own audio.
    if (t && this.current?.source === this.source) {
      const pos = this.songPosition();
      if (pos !== null) {
        const period = 60 / t.bpm;
        t.offset = ((pos % period) + period) % period;
      }
    }
  }
}
