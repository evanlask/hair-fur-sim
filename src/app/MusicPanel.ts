import type { FolderApi, ButtonApi } from 'tweakpane';

import { METAL_RIFF, MUSIC_LIBRARY, trackLabel } from '../audio/library';
import { METAL_BPM_RANGE, MusicPlayer, TRACK_BPM_RANGE, type MusicSource } from '../audio/MusicPlayer';
import type { Gui } from './Gui';
import { num, tip, toggle } from './Gui';

export interface MusicSync {
  /** Lock head motions to the music's beat while it plays. */
  enabled: boolean;
  /** Move every N beats (0.5 = double time, 1 = every beat, 2 = half time). */
  division: number;
  /** Scale motion amplitude with the music's loudness. */
  react: boolean;
}

/** GUI + keyboard controls for the music player. */
export class MusicPanel {
  readonly player = new MusicPlayer();
  readonly sync: MusicSync = { enabled: true, division: 1, react: true };
  private readonly ui = {
    source: 'metal' as MusicSource, // synced from the player in the constructor
    metalBpm: 132,
    trackBpm: 120,
    volume: 0.7,
    syncOffsetMs: 0,
    status: 'stopped',
  };
  private readonly folder: FolderApi;
  /** Called after playback starts with the track (e.g. to pick a matching head motion). */
  onPlay: ((source: MusicSource) => void) | null = null;
  /** Called when the music stops (stopped, or the next track failed to load). */
  onStop: (() => void) | null = null;
  private wasPlaying = false;
  private readonly playButton: ButtonApi;
  private readonly metalBpmBinding: ReturnType<typeof num>;
  private readonly trackBpmBinding: ReturnType<typeof num>;
  private metalTimer = 0;

  constructor(gui: Gui) {
    const p = this.player;
    const f = (this.folder = gui.folder('Music'));
    f.addBinding(this.ui, 'status', { readonly: true, label: 'status' });
    this.playButton = f.addButton({ title: '▶ Play' });
    this.playButton.on('click', () => this.togglePlay());
    const options: Record<string, string> = { [trackLabel(METAL_RIFF)]: 'metal' };
    for (const t of MUSIC_LIBRARY) options[trackLabel(t)] = t.id;
    this.ui.source = p.source;
    f.addBinding(this.ui, 'source', { label: 'track', options }).on('change', () => {
      void p.setSource(this.ui.source).then((started) => {
        if (started) this.onPlay?.(p.source);
        this.refresh();
      });
      this.refresh();
    });
    num(f, this.ui, 'volume', { min: 0, max: 1, label: 'volume' }, () => p.setVolume(this.ui.volume));

    // Beat sync: how the head follows the music, plus tempo fixes for when the beat grid feels off.
    const b = gui.folder('Beat sync', false, f);
    toggle(
      b,
      this.sync,
      'enabled',
      () => {},
      'sync head to beat',
      'Lock the head motion to the beat while music plays.',
    );
    tip(
      b.addBinding(this.sync, 'division', {
        label: 'move',
        options: {
          'every ½ beat (2× speed)': 0.5,
          'on the beat': 1,
          'every 2 beats (½ speed)': 2,
          'every 4 beats (¼ speed)': 4,
        },
      }),
      'How often the head moves relative to the beat.',
    );
    toggle(
      b,
      this.sync,
      'react',
      () => {},
      'react to loudness',
      'Bigger head motion when the music is louder.',
    );
    this.metalBpmBinding = num(
      b,
      this.ui,
      'metalBpm',
      { min: METAL_BPM_RANGE[0], max: METAL_BPM_RANGE[1], step: 1, label: 'riff BPM' },
      () => {
        // Changing the tempo re-renders and restarts the riff, so wait until the slider settles.
        clearTimeout(this.metalTimer);
        this.metalTimer = window.setTimeout(
          () => void p.setMetalBpm(this.ui.metalBpm).then(() => this.refresh()),
          250,
        );
      },
    );
    this.trackBpmBinding = num(
      b,
      this.ui,
      'trackBpm',
      {
        min: TRACK_BPM_RANGE[0],
        max: TRACK_BPM_RANGE[1],
        step: 0.01,
        digits: 2,
        label: 'track BPM',
        hint: "The track's tempo (beats per minute); fix it here if the head drifts off the beat.",
      },
      () => {
        // refresh() echoes the grid's tempo back rounded to the slider step: only apply real edits, so
        // precomputed tempos like 86.491 aren't overwritten just by showing them.
        if (p.track && Math.abs(this.ui.trackBpm - p.track.bpm) >= 0.005)
          p.setTrackBpm(Math.round(this.ui.trackBpm * 100) / 100);
      },
    );
    num(
      b,
      this.ui,
      'syncOffsetMs',
      {
        min: -300,
        max: 300,
        step: 1,
        label: 'sync offset (ms)',
        hint: 'Shifts the head motion earlier (negative) or later (positive) against the music.',
      },
      () => (p.syncOffsetMs = this.ui.syncOffsetMs),
    );
    b.addButton({ title: 'Tap tempo (T)' }).on('click', () => this.tap());
    b.addButton({ title: 'Tempo ×2' }).on('click', () => {
      p.scaleTempo(2);
      this.refresh();
    });
    b.addButton({ title: 'Tempo ÷2' }).on('click', () => {
      p.scaleTempo(0.5);
      this.refresh();
    });
    b.addButton({ title: 'Reset beat grid' }).on('click', () => {
      p.resetBeatGrid();
      this.refresh();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.repeat) return;
      if (e.key === 't' || e.key === 'T') this.tap();
      if (e.key === 'm' || e.key === 'M') void this.togglePlay();
    });
    this.refresh();
  }

  private async togglePlay(): Promise<void> {
    // Pressing again while a track is still loading cancels it.
    if (this.player.playing || this.player.pending) this.player.stop();
    else if (await this.player.play()) this.onPlay?.(this.player.source);
    this.refresh();
  }

  private tap(): void {
    this.player.tap();
    this.refresh();
  }

  /** Copies player state into the GUI. */
  refresh(): void {
    const p = this.player;
    this.ui.source = p.source;
    this.ui.metalBpm = p.metalBpm;
    if (p.track) this.ui.trackBpm = Number(p.track.bpm.toFixed(2));
    this.ui.status = p.status;
    this.playButton.title = p.playing || p.pending ? '■ Stop (M)' : '▶ Play (M)';
    this.metalBpmBinding.hidden = p.source !== 'metal';
    this.trackBpmBinding.hidden = p.source === 'metal';
    this.folder.refresh();
  }

  /** Beat count and tempo (beats/s) of what's heard, for head motions; null when not synced or not playing. */
  beat = (): { beat: number; rate: number } | null => {
    const beat = this.sync.enabled ? this.player.beat() : null;
    const now = this.player.nowPlaying;
    return beat !== null && now ? { beat, rate: now.bpm / 60 } : null;
  };

  /** Amplitude multiplier from loudness. */
  loudness = (): number =>
    this.sync.react && this.player.playing ? 0.7 + 0.45 * Math.min(1, this.player.level) : 1;

  update(dt: number): void {
    this.player.updateLevel(dt);
    if (this.wasPlaying && !this.player.playing) this.onStop?.();
    this.wasPlaying = this.player.playing;
    if (this.ui.status !== this.player.status) {
      this.ui.status = this.player.status;
      this.playButton.title = this.player.playing || this.player.pending ? '■ Stop (M)' : '▶ Play (M)';
    }
  }

  hud(): string {
    const p = this.player;
    const now = p.nowPlaying;
    if (!now) return '♪ music stopped (M to play)';
    const b = p.beat();
    const pulse = b !== null && b - Math.floor(b) < 0.18 ? '●' : '○';
    return `♪ ${now.name} · ${now.bpm.toFixed(now.metal ? 0 : 1)} BPM ${pulse}`;
  }
}
