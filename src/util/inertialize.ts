/**
 * Inertialization (as in game animation): on a switch, the output keeps the position and velocity it had and an
 * offset to the new target decays to zero, instead of crossfading from a frozen pose. The offset decays as a
 * critically damped spring, so it never overshoots, and a switch mid-transition just starts from wherever the
 * output is.
 */
export class Inertializer {
  readonly value: Float64Array;
  private readonly velocity: Float64Array;
  private readonly offset: Float64Array;
  private readonly offsetVelocity: Float64Array;
  private readonly damping: number;
  private initialized = false;

  /** `halflife` (s): time for the offset to halve (it's ~97% gone after five halflives). */
  constructor(channels: number, halflife = 0.12) {
    this.value = new Float64Array(channels);
    this.velocity = new Float64Array(channels);
    this.offset = new Float64Array(channels);
    this.offsetVelocity = new Float64Array(channels);
    this.damping = (2 * Math.LN2) / halflife;
  }

  /**
   * Advances by `dt` towards `target`. On a switch, pass the new target's value one frame earlier as
   * `switchedFrom` so its velocity is known and the output's velocity carries through the switch.
   */
  update(dt: number, target: ArrayLike<number>, switchedFrom?: ArrayLike<number>): Float64Array {
    const n = this.value.length;
    if (!this.initialized || dt <= 0) {
      for (let i = 0; i < n; i++) this.value[i] = target[i] + (this.initialized ? this.offset[i] : 0);
      this.initialized = true;
      return this.value;
    }
    const y = this.damping;
    const decay = Math.exp(-y * dt);
    for (let i = 0; i < n; i++) {
      if (switchedFrom) {
        // Where the output would be now, carried on at its velocity, relative to the new target.
        const targetVelocity = (target[i] - switchedFrom[i]) / dt;
        this.offset[i] = this.value[i] + this.velocity[i] * dt - target[i];
        this.offsetVelocity[i] = this.velocity[i] - targetVelocity;
      } else {
        const j = this.offsetVelocity[i] + this.offset[i] * y;
        this.offset[i] = decay * (this.offset[i] + j * dt);
        this.offsetVelocity[i] = decay * (this.offsetVelocity[i] - j * y * dt);
      }
      const next = target[i] + this.offset[i];
      this.velocity[i] = (next - this.value[i]) / dt;
      this.value[i] = next;
    }
    return this.value;
  }
}
