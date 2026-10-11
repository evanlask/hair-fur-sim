/**
 * Bundled tracks. Tempo and beat phase were precomputed offline with beatDetect.ts. "End of Beginning" was analysed
 * with an 80 BPM hint (its strongest periodicity isn't the pulse to nod to), and reggae and jazz-hop are stored at
 * their "felt" half tempo with the kick-aligned phase.
 */

export interface LibraryTrack {
  id: string;
  title: string;
  genre: string;
  url: string;
  bpm: number;
  /** Time (s) of a beat in the decoded file. */
  offset: number;
  /** Head motion an idle head starts when the track plays (default: headbang). */
  motion?: 'roxbury' | 'nod';
}

/** In the menu, status line and HUD every track is named "Title (genre)". */
export const trackLabel = (t: { title: string; genre: string }) => `${t.title} (${t.genre})`;

/** The synthesized metal riff (source 'metal'). */
export const METAL_RIFF = { title: 'Headbanger Riff', genre: 'metal' };

/** The first track is the default (the menu lists them A to Z). */
export const MUSIC_LIBRARY: LibraryTrack[] = [
  {
    id: 'what-is-love',
    title: 'What Is Love',
    genre: 'eurodance',
    url: 'music/what-is-love.mp3',
    bpm: 124,
    offset: 0.314,
    motion: 'roxbury',
  },
  {
    id: 'end-of-beginning',
    title: 'End of Beginning',
    genre: 'indie pop',
    url: 'music/end-of-beginning.mp3',
    bpm: 80,
    offset: 0.147,
    motion: 'nod',
  },
  {
    id: 'starcourt-mall',
    title: 'Starcourt Mall',
    genre: 'synthwave',
    url: 'music/starcourt-mall.mp3',
    bpm: 103,
    offset: 0.03,
  },
  {
    id: 'funkeriffic',
    title: 'Funkeriffic',
    genre: 'funk',
    url: 'music/funkeriffic.mp3',
    bpm: 112,
    offset: 0.027,
  },
  {
    id: 'sunny-rasta',
    title: 'Sunny Rasta',
    genre: 'reggae',
    url: 'music/sunny-rasta.mp3',
    bpm: 86.491,
    offset: 0.63,
  },
  {
    id: 'blippy-trance',
    title: 'Blippy Trance',
    genre: 'trance',
    url: 'music/blippy-trance.mp3',
    bpm: 133.365,
    offset: 0.009,
  },
  {
    id: 'hillbilly-swing',
    title: 'Hillbilly Swing',
    genre: 'country',
    url: 'music/hillbilly-swing.mp3',
    bpm: 144,
    offset: 0.294,
  },
  {
    id: 'take-the-sting-out',
    title: 'Take the Sting Out',
    genre: 'jazz-hop',
    url: 'music/take-the-sting-out.mp3',
    bpm: 85,
    offset: 0.285,
  },
];

export function motionForTrack(id: string): 'roxbury' | 'nod' | 'headbang' {
  return MUSIC_LIBRARY.find((t) => t.id === id)?.motion ?? 'headbang';
}
