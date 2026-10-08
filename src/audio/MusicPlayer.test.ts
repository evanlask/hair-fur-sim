import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// The riff renders with OfflineAudioContext, which Node doesn't have: return a buffer tagged with its tempo.
vi.mock('./metalSynth', () => ({
  renderMetalLoop: async (bpm: number) => ({ buffer: fakeBuffer(`metal@${bpm}`), beats: 16 }),
}));

import { MUSIC_LIBRARY } from './library';
import { MusicPlayer } from './MusicPlayer';

type Tagged = AudioBuffer & { tag: string };
function fakeBuffer(tag: string): Tagged {
  return { tag, duration: 200 } as unknown as Tagged;
}

/** Minimal AudioContext: a controllable clock and source nodes that record what they play. */
class FakeAudioContext {
  static instance: FakeAudioContext;
  currentTime = 0;
  sampleRate = 48000;
  outputLatency = 0;
  baseLatency = 0;
  destination = {};
  playing: { buffer: Tagged | null; stopped: boolean }[] = [];
  constructor() {
    FakeAudioContext.instance = this;
  }
  resume = async () => {};
  createGain = () => ({ gain: { value: 1 }, connect: (n: unknown) => n });
  createAnalyser = () => ({ fftSize: 1024, connect: (n: unknown) => n, getFloatTimeDomainData: () => {} });
  createBufferSource = () => {
    const rec = { buffer: null as Tagged | null, stopped: false };
    return {
      set buffer(b: Tagged) {
        rec.buffer = b;
      },
      loop: false,
      connect: () => {},
      disconnect: () => {},
      start: () => this.playing.push(rec),
      stop: () => (rec.stopped = true),
    };
  };
  decodeAudioData = async (data: { tag: string }) => fakeBuffer(data.tag);
  /** Tags of the source nodes still playing. */
  get audible(): string[] {
    return this.playing.filter((p) => !p.stopped).map((p) => p.buffer!.tag);
  }
}

/** fetch() whose responses resolve only when released, so loads can be interleaved. */
const pendingFetches = new Map<string, (ok: boolean) => void>();
async function release(url: string, ok = true): Promise<void> {
  await flush(); // play() awaits resume() before it fetches
  pendingFetches.get(url)!(ok);
  pendingFetches.delete(url);
  await flush();
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const [WIL, EOB, FUNK] = MUSIC_LIBRARY;

beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('fetch', (url: string) => {
    return new Promise((resolve) => {
      pendingFetches.set(url, (ok) =>
        resolve({ ok, status: ok ? 200 : 404, arrayBuffer: async () => ({ tag: url }) }),
      );
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  pendingFetches.clear();
});

describe('MusicPlayer', () => {
  it('plays the newly selected track when the source changes while the first one is still loading', async () => {
    const p = new MusicPlayer();
    const first = p.play();
    await flush();
    expect(p.pending).toBe(true);
    const second = p.setSource(FUNK.id);
    await release(WIL.url);
    expect(await first).toBe(false);
    expect(FakeAudioContext.instance.audible).toEqual([]);
    await release(FUNK.url);
    expect(await second).toBe(true);
    expect(FakeAudioContext.instance.audible).toEqual([FUNK.url]);
    expect(p.nowPlaying?.name).toBe(p.trackName);
  });

  it('stopping while a track loads cancels it', async () => {
    const p = new MusicPlayer();
    const started = p.play();
    await flush();
    p.stop();
    await release(WIL.url);
    expect(await started).toBe(false);
    expect(p.playing).toBe(false);
    expect(FakeAudioContext.instance.audible).toEqual([]);
  });

  it('stops the previous track when the next one fails to load', async () => {
    const p = new MusicPlayer();
    const started = p.play();
    await release(WIL.url);
    expect(await started).toBe(true);
    const switched = p.setSource(EOB.id);
    await release(EOB.url, false);
    expect(await switched).toBe(false);
    expect(p.playing).toBe(false);
    expect(FakeAudioContext.instance.audible).toEqual([]);
    expect(p.status).toMatch(/could not load/);
  });

  it('keeps the beat clock on the old track while the next one loads', async () => {
    const p = new MusicPlayer();
    const started = p.play();
    await release(WIL.url);
    await started;
    const ctx = FakeAudioContext.instance;
    ctx.currentTime = 0.06 + WIL.offset + 10;
    const before = p.beat()!;
    expect(before).toBeCloseTo((10 * WIL.bpm) / 60, 6);
    void p.setSource(EOB.id);
    await flush();
    expect(p.beat()).toBeCloseTo(before, 6); // still What Is Love's grid
    expect(p.nowPlaying?.name).toMatch(/What Is Love/);
  });

  it('uses the tempo of the riff actually heard until the re-render at a new tempo starts', async () => {
    const p = new MusicPlayer();
    p.source = 'metal';
    await p.play();
    const ctx = FakeAudioContext.instance;
    ctx.currentTime = 0.06 + 10;
    p.metalBpm = 200; // as setMetalBpm does before the re-render finishes
    expect(p.beat()).toBeCloseTo((10 * 132) / 60, 6);
    await p.setMetalBpm(200);
    expect(ctx.audible).toEqual(['metal@200']);
  });

  it('exposes and keeps edits to the beat grid before the track has loaded', () => {
    const p = new MusicPlayer();
    expect(p.track?.bpm).toBe(WIL.bpm);
    p.setTrackBpm(124.5);
    expect(p.track?.bpm).toBe(124.5);
  });

  it('clamps tempo from taps, sliders and ×2', async () => {
    const p = new MusicPlayer();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (let i = 0; i < 5; i++, now += 50) p.tap(); // 1200 BPM
    expect(p.track?.bpm).toBe(240);
    p.setTrackBpm(5);
    expect(p.track?.bpm).toBe(40);
    p.source = 'metal';
    for (let i = 0; i < 5; i++, now += 50) p.tap();
    expect(p.metalBpm).toBe(220);
    p.scaleTempo(0.1);
    await flush();
    expect(p.metalBpm).toBe(50);
    vi.restoreAllMocks();
  });

  it('keeps only the latest decoded track cached', async () => {
    const p = new MusicPlayer();
    const play = async () => {
      const r = p.play();
      await flush();
      if (pendingFetches.size) await release([...pendingFetches.keys()][0]);
      return r;
    };
    await play(); // What Is Love: fetch
    await play(); // restart: cached, no fetch
    expect(pendingFetches.size).toBe(0);
    p.source = FUNK.id;
    await play(); // Funkeriffic: fetch (What Is Love dropped)
    p.source = WIL.id;
    const again = p.play();
    await flush();
    expect(pendingFetches.has(WIL.url)).toBe(true);
    await release(WIL.url);
    expect(await again).toBe(true);
  });
});
