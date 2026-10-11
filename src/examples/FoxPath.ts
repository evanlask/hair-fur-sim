import * as THREE from 'three/webgpu';

import { Rng } from '../util/rng';

/** Total radius wobble (fraction of the radius) at wiggle 1. */
export const MAX_WOBBLE = 0.22;
/**
 * Closest two foxes come, centre to centre (m). A fox is about 1 m from snout to tail tip, so this lets one walk
 * right behind the other with a small gap.
 */
export const MIN_SEPARATION = 1.15;
/** Peak fraction by which a fox speeds up or slows down while drifting. */
const SPEED_VARIATION = 0.1;

interface Wave {
  k: number;
  amplitude: number;
  phase: number;
  /** Slow phase drift (rad/s), so the loop keeps changing shape. */
  drift: number;
}

/**
 * A wobbly closed loop the foxes walk: a circle whose radius varies with angle (a few smooth harmonics that
 * slowly drift). Each direction from the centre meets the loop once, so it never crosses itself.
 *
 * Fox 0 and fox 1 start on opposite sides; their angles drift ahead of and behind that by a slow, bounded wave,
 * so each speeds up and slows down a little and now and then one closes up behind the other. Their angle apart
 * stays within π ± maxStagger(), the most that keeps them MIN_SEPARATION apart on the loop's smallest radius
 * r_min = radius·(1 − wiggle·MAX_WOBBLE) (on a loop too small for that, they stay opposite, 2·r_min apart), so
 * they never touch or pass each other.
 */
export class FoxPath {
  readonly center = new THREE.Vector3();
  radius = 1.3;
  /** 0 = plain circle, 1 = default wobble. */
  wiggle = 1;
  /** Shared clock: fox i stands at `angle` + i·π + its stagger. */
  angle = 0;
  /** Angular rate of the shared clock in the last advance (rad/s). */
  rate = 0;
  private time = 0;
  /** Phase of the stagger wave and its rate in the last advance. */
  private staggerPhase = 0;
  private staggerRate = 0;
  private waves: Wave[] = [];

  constructor(seed = 1) {
    this.reseed(seed);
  }

  /** Picks a new random loop shape. */
  reseed(seed: number): void {
    const rng = new Rng(seed);
    // Amplitudes fall off as 1/k², so every harmonic bends the path about equally (no tight kinks).
    const waves = [2, 3, 4].map((k) => ({
      k,
      amplitude: rng.range(0.5, 1) / (k * k),
      phase: rng.next() * Math.PI * 2,
      drift: rng.range(-0.04, 0.04),
    }));
    const sum = waves.reduce((s, w) => s + w.amplitude, 0);
    for (const w of waves) w.amplitude *= MAX_WOBBLE / sum;
    this.waves = waves;
  }

  /** Radius (m) and its derivative dr/dθ at angle θ. */
  private radiusAt(theta: number): [number, number] {
    let r = 1;
    let dr = 0;
    for (const w of this.waves) {
      const x = w.k * theta + w.phase + w.drift * this.time;
      r += this.wiggle * w.amplitude * Math.sin(x);
      dr += this.wiggle * w.amplitude * w.k * Math.cos(x);
    }
    return [r * this.radius, dr * this.radius];
  }

  point(theta: number, out: THREE.Vector3): THREE.Vector3 {
    const [r] = this.radiusAt(theta);
    return out.set(this.center.x + Math.cos(theta) * r, this.center.y, this.center.z + Math.sin(theta) * r);
  }

  /** Ground distance per radian at θ (|dp/dθ|). */
  stride(theta: number): number {
    const [r, dr] = this.radiusAt(theta);
    return Math.hypot(r, dr);
  }

  /** Yaw facing along the direction of travel (models face +Z). */
  heading(theta: number): number {
    const [r, dr] = this.radiusAt(theta);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return Math.atan2(dr * c - r * s, dr * s + r * c);
  }

  /** Stagger wave in [-1, 1] and its derivative per unit phase. */
  private wave(): [number, number] {
    const p = this.staggerPhase;
    return [
      0.7 * Math.sin(p) + 0.3 * Math.sin(1.7 * p + 1.3),
      0.7 * Math.cos(p) + 0.51 * Math.cos(1.7 * p + 1.3),
    ];
  }

  /**
   * Most the angle between the foxes strays from opposite (rad): two points at least r_min from the centre and Δ
   * apart in angle are at least 2·r_min·sin(Δ/2) apart, so Δ may shrink to where that equals MIN_SEPARATION.
   */
  maxStagger(): number {
    const rMin = this.radius * (1 - this.wiggle * MAX_WOBBLE);
    const minAngle = 2 * Math.asin(Math.min(1, MIN_SEPARATION / (2 * rMin)));
    return Math.PI - minAngle;
  }

  /** Fox 0 drifts back as fox 1 drifts ahead, each by up to half of maxStagger(). */
  private sign(fox: number): number {
    return fox % 2 === 0 ? -0.5 : 0.5;
  }

  /** Angle on the loop of fox `fox` (0 or 1). */
  foxAngle(fox: number): number {
    return this.angle + fox * Math.PI + this.sign(fox) * this.maxStagger() * this.wave()[0];
  }

  /** Angular rate (rad/s) of fox `fox` in the last advance. */
  foxRate(fox: number): number {
    return this.rate + this.sign(fox) * this.maxStagger() * this.wave()[1] * this.staggerRate;
  }

  /** Advances the shared clock so `count` foxes average `speed` m/s along the loop. */
  advance(dt: number, speed: number, count: number): void {
    if (speed <= 0 || count === 0) {
      this.rate = 0;
      this.staggerRate = 0;
      return;
    }
    this.time += dt;
    let stride = 0;
    for (let i = 0; i < count; i++) stride += this.stride(this.foxAngle(i));
    this.rate = speed / (stride / count);
    // Paced by the walking speed, so a fox's speed varies by about ±SPEED_VARIATION at any speed or radius
    // (|wave'| ≤ 1.21, and stride ≈ radius). With no room to stagger the wave doesn't matter.
    const stagger = this.maxStagger();
    this.staggerRate = stagger > 1e-6 ? (SPEED_VARIATION * speed) / (0.5 * stagger * 1.21 * this.radius) : 0;
    this.angle += this.rate * dt;
    this.staggerPhase += this.staggerRate * dt;
  }
}
