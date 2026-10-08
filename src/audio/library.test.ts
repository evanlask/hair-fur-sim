import { describe, expect, it } from 'vite-plus/test';

import { MUSIC_LIBRARY } from './library';

// Lazy globs only list the files; nothing is loaded.
const musicFiles = Object.keys(import.meta.glob('../../public/music/*.mp3')).map((p) =>
  p.replace('../../public/', ''),
);

describe('music library', () => {
  it('points every track at a file in public/music', () => {
    for (const track of MUSIC_LIBRARY) expect(musicFiles).toContain(track.url);
  });

  it('has unique ids and plausible beat grids', () => {
    expect(new Set(MUSIC_LIBRARY.map((t) => t.id)).size).toBe(MUSIC_LIBRARY.length);
    for (const { bpm, offset } of MUSIC_LIBRARY) {
      expect(bpm).toBeGreaterThanOrEqual(60);
      expect(bpm).toBeLessThanOrEqual(200);
      // The offset is the time of one beat, so it can always be within the first beat period.
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(60 / bpm);
    }
  });
});
