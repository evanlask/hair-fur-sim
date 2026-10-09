import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { closestOnSegment, ColliderSet, shapeSdf } from './colliders';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('closestOnSegment', () => {
  const a = v(0, 0, 0);
  const b = v(1, 0, 0);
  const out = new THREE.Vector3();

  it('projects onto the segment and clamps to its ends', () => {
    expect(closestOnSegment(v(0.25, 1, 0), a, b, out).toArray()).toEqual([0.25, 0, 0]);
    expect(closestOnSegment(v(-2, 1, 0), a, b, out).toArray()).toEqual([0, 0, 0]);
    expect(closestOnSegment(v(3, -1, 0), a, b, out).toArray()).toEqual([1, 0, 0]);
  });

  it('treats a zero-length segment as a point', () => {
    expect(closestOnSegment(v(1, 2, 3), b, b, out).toArray()).toEqual([1, 0, 0]);
  });
});

describe('shapeSdf', () => {
  it('sphere', () => {
    const p = new THREE.Vector4(0.5, 0, 0, 0);
    expect(shapeSdf('sphere', p, v(0, 0, 0))).toBeCloseTo(-0.5);
    expect(shapeSdf('sphere', p, v(0, 2, 0))).toBeCloseTo(1.5);
  });

  it('torus around the y axis', () => {
    const p = new THREE.Vector4(1, 0.25, 0, 0);
    expect(shapeSdf('torus', p, v(1, 0, 0))).toBeCloseTo(-0.25);
    expect(shapeSdf('torus', p, v(0, 0, -1))).toBeCloseTo(-0.25);
    expect(shapeSdf('torus', p, v(0, 0, 0))).toBeCloseTo(0.75);
    expect(shapeSdf('torus', p, v(1, 0.5, 0))).toBeCloseTo(0.25);
  });

  it('box, sharp and rounded', () => {
    const sharp = new THREE.Vector4(1, 2, 3, 0);
    expect(shapeSdf('box', sharp, v(0, 0, 0))).toBeCloseTo(-1);
    expect(shapeSdf('box', sharp, v(2, 0, 0))).toBeCloseTo(1);
    expect(shapeSdf('box', sharp, v(2, 3, 4))).toBeCloseTo(Math.sqrt(3));

    const rounded = new THREE.Vector4(1, 2, 3, 0.2);
    expect(shapeSdf('box', rounded, v(2, 0, 0))).toBeCloseTo(1);
    // Off a corner the distance is to the rounding sphere around the inner box's corner.
    expect(shapeSdf('box', rounded, v(2, 3, 4))).toBeCloseTo(Math.sqrt(3) * 1.2 - 0.2);
  });

  it('none is infinitely far away', () => {
    expect(shapeSdf('none', new THREE.Vector4(), v(0, 0, 0))).toBe(Infinity);
  });
});

describe('ColliderSet', () => {
  it('transforms capsules by their attachment but keeps the radius in world units', () => {
    const bone = new THREE.Object3D();
    bone.position.set(1, 0, 0);
    bone.scale.setScalar(2);
    bone.updateMatrixWorld();
    const set = new ColliderSet().add({ name: 'c', a: v(0, 0, 0), b: v(0, 1, 0), radius: 0.1, attach: bone });
    set.radiusScale = 1.5;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const r = set.worldCapsule(0, a, b);
    expect(a.toArray()).toEqual([1, 0, 0]);
    expect(b.toArray()).toEqual([1, 2, 0]);
    expect(r).toBeCloseTo(0.15);
    expect(set.capsuleDistance(0, v(2, 1, 0))).toBeCloseTo(0.85);
  });

  it('pushes points out of enabled capsules to radius + margin', () => {
    const set = new ColliderSet().add({ name: 'c', a: v(0, 0, 0), b: v(0, 1, 0), radius: 0.2, attach: null });
    const p = v(0.05, 0.5, 0);
    expect(set.pushOut(p, 0b1, 0.01)).toBe(true);
    expect(p.x).toBeCloseTo(0.21);
    expect(p.y).toBeCloseTo(0.5);

    const outside = v(0.5, 0.5, 0);
    expect(set.pushOut(outside, 0b1, 0.01)).toBe(false);
    expect(outside.toArray()).toEqual([0.5, 0.5, 0]);
  });

  it('skips capsules whose mask bit is clear, except beyond the 32 bits the mask can hold', () => {
    const set = new ColliderSet();
    for (let i = 0; i < 33; i++)
      set.add({ name: `c${i}`, a: v(i, 0, 0), b: v(i, 0, 0), radius: 0.2, attach: null });

    const p = v(0, 0.1, 0);
    expect(set.pushOut(p, ~1, 0)).toBe(false);
    expect(set.pushOut(p, 1, 0)).toBe(true);
    expect(p.y).toBeCloseTo(0.2);

    const q = v(32, 0.1, 0);
    expect(set.pushOut(q, 0, 0)).toBe(true);
    expect(q.y).toBeCloseTo(0.2);
  });

  it('pushes points out of the analytic shape along its normal', () => {
    const holder = new THREE.Object3D();
    holder.position.set(0, 1, 0);
    holder.updateMatrixWorld();
    const set = new ColliderSet();
    set.setShape('sphere', new THREE.Vector4(0.5, 0, 0, 0), holder);

    const p = v(0, 1.2, 0);
    expect(set.shapeDistance(p)).toBeCloseTo(-0.3);
    expect(set.pushOut(p, 0, 0.05)).toBe(true);
    expect(p.y).toBeCloseTo(1.55);
    expect(p.x).toBeCloseTo(0);
  });

  it('swaps capsules after clear()', () => {
    const set = new ColliderSet()
      .add({ name: 'a', a: v(0, 0, 0), b: v(0, 1, 0), radius: 0.2, attach: null })
      .add({ name: 'b', a: v(5, 0, 0), b: v(5, 1, 0), radius: 0.2, attach: null });
    set.update(true);
    expect(set.count.value).toBe(2);

    set.clear().add({ name: 'c', a: v(2, 0, 0), b: v(2, 1, 0), radius: 0.1, attach: null });
    set.update(true);
    expect(set.count.value).toBe(1);
    expect(set.capsules.map((c) => c.name)).toEqual(['c']);
    // The old capsules no longer collide; the new one does.
    expect(set.pushOut(v(0.05, 0.5, 0), 0xffffffff, 0.01)).toBe(false);
    expect(set.pushOut(v(2.05, 0.5, 0), 0xffffffff, 0.01)).toBe(true);
  });
});
