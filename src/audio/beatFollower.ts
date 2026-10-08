/**
 * A beat count that never jumps. It advances at the current tempo; given a reference beat (the music's), it
 * speeds up or slows down to converge on it. Tempo edits, track switches and sync-offset changes then ease the
 * motion onto the new beat instead of snapping it there.
 */
export class BeatFollower {
  beat = 0;
  /** How quickly (s) a phase error is corrected: ~95% after three time constants. */
  private readonly timeConstant: number;

  constructor(timeConstant = 0.35) {
    this.timeConstant = timeConstant;
  }

  /** Advances by `dt` seconds at `rate` beats/s, steering towards `target` (the beat count now) when given. */
  update(dt: number, rate: number, target: number | null = null): number {
    let speed = rate;
    if (target !== null) {
      // Error to the nearest reference beat, in [-0.5, 0.5], measured against where this frame's step lands.
      // The count's integer part is free.
      const diff = target - (this.beat + rate * dt);
      const error = diff - Math.round(diff);
      // Never backwards, never more than double time.
      speed = Math.min(rate * 2, Math.max(rate * 0.25, rate + error / this.timeConstant));
    }
    this.beat += speed * dt;
    return this.beat;
  }
}
