import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { createFields } from '../../hair/groom/styles/paintedStyle';
import {
  MAP_LENGTH_MAX,
  TOOL_CHANNELS,
  applyDab,
  defaultBrush,
  falloff,
  mirrorDirection,
  mirrorPoint,
  type Dab,
} from './brushes';
import { diffChange, History, StrokeRecorder, writeValues, type PaintChange } from './history';
import { buildPaintMesh } from './paintMesh';

const R = 0.1;
const mesh = buildPaintMesh(new THREE.SphereGeometry(R, 48, 32), 0, 0.02);
const P = mesh.positions;

/** A dab on the sphere at the point in direction `dir`. */
function dabAt(dir: THREE.Vector3, opts: Partial<Dab> = {}): Dab {
  const n = dir.clone().normalize();
  return {
    center: n.clone().multiplyScalar(R),
    normal: n,
    direction: null,
    radius: 0.03,
    pressure: 1,
    invert: false,
    ...opts,
  };
}

const dist = (i: number, c: THREE.Vector3) =>
  Math.hypot(P[i * 3] - c.x, P[i * 3 + 1] - c.y, P[i * 3 + 2] - c.z);

describe('brush falloff', () => {
  it('is 1 at the centre, 0 at the radius and falls monotonically', () => {
    expect(falloff(0)).toBe(1);
    expect(falloff(1)).toBe(0);
    for (let t = 0; t < 1; t += 0.05) expect(falloff(t + 0.05)).toBeLessThanOrEqual(falloff(t));
  });
});

describe('brushes', () => {
  const brush = { ...defaultBrush(), strength: 1 };
  const none = () => {};

  it('paints density inside the radius only, and not on the far side', () => {
    const f = createFields(mesh.count);
    const d = dabAt(new THREE.Vector3(0, 1, 0));
    const hits = applyDab('density', f, mesh, d, brush, none);
    expect(hits.length).toBeGreaterThan(5);
    for (let i = 0; i < mesh.count; i++) {
      if (dist(i, d.center) >= d.radius) expect(f.density[i]).toBe(0);
      else if (dist(i, d.center) < d.radius * 0.3) expect(f.density[i]).toBeGreaterThan(0.5);
    }
    // A dab with the radius of the whole sphere still leaves the opposite side alone (facing test).
    const big = { ...d, radius: 3 * R };
    applyDab('density', f, mesh, big, brush, none);
    for (let i = 0; i < mesh.count; i++) if (P[i * 3 + 1] < -0.05 * R) expect(f.density[i]).toBe(0);
  });

  it('erases with Shift', () => {
    const f = createFields(mesh.count);
    f.density.fill(1);
    const d = dabAt(new THREE.Vector3(1, 0, 0), { invert: true });
    applyDab('density', f, mesh, d, brush, none);
    for (let i = 0; i < mesh.count; i++)
      if (dist(i, d.center) < d.radius * 0.2) expect(f.density[i]).toBeLessThan(0.1);
  });

  it('only shortens with cut-only', () => {
    const f = createFields(mesh.count);
    f.length.fill(0.1);
    const d = dabAt(new THREE.Vector3(0, 0, 1));
    applyDab('length', f, mesh, d, { ...brush, cutOnly: true, value: { ...brush.value, length: 0.3 } }, none);
    for (let i = 0; i < mesh.count; i++) expect(f.length[i]).toBeCloseTo(0.1, 6);
    applyDab(
      'length',
      f,
      mesh,
      d,
      { ...brush, cutOnly: true, value: { ...brush.value, length: 0.02 } },
      none,
    );
    for (let i = 0; i < mesh.count; i++) expect(f.length[i]).toBeLessThanOrEqual(0.1 + 1e-6);
  });

  it('combs the flow towards the stroke, on the surface and unit length', () => {
    const f = createFields(mesh.count);
    for (let i = 0; i < mesh.count; i++) f.flow.set([0, 0, 1], i * 3);
    const stroke = new THREE.Vector3(1, 0, 0);
    const d = dabAt(new THREE.Vector3(0, 1, 0), { direction: stroke });
    const hits = applyDab('comb', f, mesh, d, brush, none);
    for (const i of hits) {
      const v = new THREE.Vector3().fromArray(f.flow, i * 3);
      const n = new THREE.Vector3().fromArray(mesh.normals, i * 3);
      expect(v.length()).toBeCloseTo(1, 5);
      expect(Math.abs(v.dot(n))).toBeLessThan(1e-4);
      if (dist(i, d.center) < d.radius * 0.3) expect(v.dot(stroke)).toBeGreaterThan(0.6);
    }
  });

  it('parts the flow away from the stroke line on either side', () => {
    const f = createFields(mesh.count);
    for (let i = 0; i < mesh.count; i++) f.flow.set([0, -1, 0], i * 3);
    // A parting along z across the top: flows point to ±x.
    const d = dabAt(new THREE.Vector3(0, 1, 0), { direction: new THREE.Vector3(0, 0, 1) });
    const hits = applyDab('part', f, mesh, d, brush, none);
    let checked = 0;
    for (const i of hits) {
      const x = P[i * 3];
      if (Math.abs(x) < 0.005 || dist(i, d.center) > d.radius * 0.6) continue;
      expect(Math.sign(f.flow[i * 3])).toBe(Math.sign(x));
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('smooths without changing a constant map', () => {
    const f = createFields(mesh.count);
    f.length.fill(0.07);
    f.lift.fill(0.3);
    for (let i = 0; i < mesh.count; i++) f.flow.set([0, 0, 1], i * 3);
    applyDab('smooth', f, mesh, dabAt(new THREE.Vector3(0, 0, 1)), brush, none);
    for (let i = 0; i < mesh.count; i++) {
      expect(f.length[i]).toBeCloseTo(0.07, 6);
      expect(f.lift[i]).toBeCloseTo(0.3, 6);
    }
  });

  it('smooths a spike towards its neighbours', () => {
    const f = createFields(mesh.count);
    const d = dabAt(new THREE.Vector3(0, 0, 1));
    let spike = 0;
    let best = Infinity;
    for (let i = 0; i < mesh.count; i++)
      if (dist(i, d.center) < best) {
        best = dist(i, d.center);
        spike = i;
      }
    f.length[spike] = 1;
    applyDab('smooth', f, mesh, d, brush, none);
    expect(f.length[spike]).toBeLessThan(0.5);
  });

  it('mirrors a dab onto the other side of the face', () => {
    const f = createFields(mesh.count);
    const d = dabAt(new THREE.Vector3(0.6, 0.8, 0.2));
    applyDab('density', f, mesh, d, brush, none);
    const m: Dab = {
      ...d,
      center: mirrorPoint(d.center, 0, new THREE.Vector3()),
      normal: mirrorDirection(d.normal, new THREE.Vector3()),
    };
    applyDab('density', f, mesh, m, brush, none);
    for (let i = 0; i < mesh.count; i++) expect(f.density[i]).toBeCloseTo(f.density[mesh.mirror[i]], 1);
  });
});

describe('noise brush', () => {
  const brush = { ...defaultBrush(), strength: 1, value: { ...defaultBrush().value, noise: 1 } };
  const UP = new THREE.Vector3(0, 1, 0);
  /** An even shape: 7 cm long, 30% lift, combed up the sphere. */
  function even() {
    const f = createFields(mesh.count);
    f.length.fill(0.07);
    f.lift.fill(0.3);
    f.curve.fill(5);
    f.wave.fill(0.002);
    for (let i = 0; i < mesh.count; i++) {
      const n = new THREE.Vector3().fromArray(mesh.normals, i * 3);
      UP.clone()
        .addScaledVector(n, -n.y)
        .normalize()
        .toArray(f.flow, i * 3);
    }
    return f;
  }
  /** One stroke dabbing the same spot `n` times, with the stroke's start values (as the paint controller does). */
  function stroke(f: ReturnType<typeof even>, n: number, opts: Partial<Dab> = {}, strength = 1) {
    const rec = new StrokeRecorder(f, TOOL_CHANNELS.noise);
    const d = dabAt(new THREE.Vector3(0, 0.3, 1), { seed: 7, ...opts });
    for (let k = 0; k < n; k++)
      applyDab('noise', f, mesh, d, { ...brush, strength }, rec.touch, rec.startValue);
    return d;
  }
  const angle = (f: ReturnType<typeof even>, g: ReturnType<typeof even>, i: number) =>
    new THREE.Vector3().fromArray(f.flow, i * 3).angleTo(new THREE.Vector3().fromArray(g.flow, i * 3));

  it('roughens the length, lift and comb under the brush, and leaves the rest alone', () => {
    const base = even();
    const f = even();
    const d = stroke(f, 1);
    const inner: number[] = [];
    for (let i = 0; i < mesh.count; i++) if (dist(i, d.center) < d.radius * 0.5) inner.push(i);
    const lengths = inner.map((i) => f.length[i]);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeGreaterThan(0.01);
    expect(Math.max(...inner.map((i) => Math.abs(f.lift[i] - 0.3)))).toBeGreaterThan(0.03);
    expect(Math.max(...inner.map((i) => angle(f, base, i)))).toBeGreaterThan(0.1);
    for (let i = 0; i < mesh.count; i++) {
      // Within the amount's range, the comb still on the surface.
      expect(f.length[i]).toBeGreaterThanOrEqual(0.07 * 0.5 - 1e-6);
      expect(f.length[i]).toBeLessThanOrEqual(0.07 * 1.5 + 1e-6);
      const v = new THREE.Vector3().fromArray(f.flow, i * 3);
      expect(v.length()).toBeCloseTo(1, 5);
      expect(Math.abs(v.dot(new THREE.Vector3().fromArray(mesh.normals, i * 3)))).toBeLessThan(1e-4);
    }
    expect(Array.from(f.density)).toEqual(Array.from(base.density));
    expect(Array.from(f.curve)).toEqual(Array.from(base.curve));
    expect(Array.from(f.gravity)).toEqual(Array.from(base.gravity));
    expect(Array.from(f.wave)).toEqual(Array.from(base.wave));
  });

  it("doesn't pile up when a stroke dabs a spot again and again", () => {
    const a = even();
    const b = even();
    const d = stroke(a, 60);
    stroke(b, 600);
    for (let i = 0; i < mesh.count; i++) {
      // Settled where the brush is strong, and never past the amount's range anywhere.
      if (dist(i, d.center) < d.radius * 0.5) {
        expect(a.length[i]).toBeCloseTo(b.length[i], 6);
        expect(a.lift[i]).toBeCloseTo(b.lift[i], 6);
        expect(angle(a, b, i)).toBeLessThan(1e-4);
      }
      expect(b.length[i]).toBeGreaterThanOrEqual(0.07 * 0.5 - 1e-6);
      expect(b.length[i]).toBeLessThanOrEqual(0.07 * 1.5 + 1e-6);
      expect(Math.abs(b.lift[i] - 0.3)).toBeLessThanOrEqual(0.25 + 1e-6);
    }
  });

  it('makes a different pattern each stroke', () => {
    const a = even();
    const b = even();
    const d = stroke(a, 1, { seed: 1 });
    stroke(b, 1, { seed: 2 });
    let differ = 0;
    for (let i = 0; i < mesh.count; i++)
      if (dist(i, d.center) < d.radius * 0.6 && Math.abs(a.length[i] - b.length[i]) > 0.001) differ++;
    expect(differ).toBeGreaterThan(5);
  });

  it('mirrors its pattern with symmetry', () => {
    const f = even();
    const rec = new StrokeRecorder(f, TOOL_CHANNELS.noise);
    const d = dabAt(new THREE.Vector3(0.6, 0.3, 0.8), { seed: 3 });
    const m: Dab = {
      ...d,
      center: mirrorPoint(d.center, 0, new THREE.Vector3()),
      normal: mirrorDirection(d.normal, new THREE.Vector3()),
      mirrorX: 0,
    };
    const hits = [
      ...applyDab('noise', f, mesh, d, brush, rec.touch, rec.startValue),
      ...applyDab('noise', f, mesh, m, brush, rec.touch, rec.startValue),
    ];
    expect(hits.length).toBeGreaterThan(10);
    for (const i of hits) {
      const j = mesh.mirror[i];
      expect(f.length[i]).toBeCloseTo(f.length[j], 3);
      expect(f.lift[i]).toBeCloseTo(f.lift[j], 3);
      // The comb mirrored: x flips.
      expect(f.flow[i * 3]).toBeCloseTo(-f.flow[j * 3], 2);
      expect(f.flow[i * 3 + 1]).toBeCloseTo(f.flow[j * 3 + 1], 2);
    }
  });
});

describe('stroke history', () => {
  it('gives the values from before the stroke', () => {
    const f = createFields(mesh.count);
    f.length.fill(0.05);
    const rec = new StrokeRecorder(f, TOOL_CHANNELS.length);
    const brush = { ...defaultBrush(), strength: 1, value: { ...defaultBrush().value, length: 0.2 } };
    const d = dabAt(new THREE.Vector3(0, 1, 0));
    const hits = applyDab('length', f, mesh, d, brush, rec.touch);
    const i = hits.reduce((a, b) => (dist(b, d.center) < dist(a, d.center) ? b : a));
    expect(f.length[i]).not.toBeCloseTo(0.05, 3);
    expect(rec.startValue('length', i)).toBeCloseTo(0.05, 6);
    // Untouched vertices (and channels the stroke doesn't record) read their current values.
    f.lift[i] = 0.4;
    expect(rec.startValue('lift', i)).toBeCloseTo(0.4, 6);
  });

  it('undoes and redoes a stroke exactly', () => {
    const f = createFields(mesh.count);
    f.length.fill(0.05);
    const before = f.length.slice();
    const rec = new StrokeRecorder(f, TOOL_CHANNELS.length);
    const brush = { ...defaultBrush(), strength: 1, value: { ...defaultBrush().value, length: 0.2 } };
    applyDab('length', f, mesh, dabAt(new THREE.Vector3(0, 1, 0)), brush, rec.touch);
    applyDab('length', f, mesh, dabAt(new THREE.Vector3(0.2, 1, 0)), brush, rec.touch);
    const after = f.length.slice();
    const change = rec.finish('layer', 'length')!;
    expect(change.indices.length).toBeGreaterThan(0);
    const history = new History((c: PaintChange, values) => writeValues(f, c, values));
    history.push(change);
    history.undo();
    expect(Array.from(f.length)).toEqual(Array.from(before));
    history.redo();
    expect(Array.from(f.length)).toEqual(Array.from(after));
    expect(history.canRedo).toBe(false);
  });

  it('records the flow (three values per vertex) and touches each vertex once', () => {
    const f = createFields(mesh.count);
    for (let i = 0; i < mesh.count; i++) f.flow.set([0, 0, 1], i * 3);
    const before = f.flow.slice();
    const rec = new StrokeRecorder(f, TOOL_CHANNELS.comb);
    const d = dabAt(new THREE.Vector3(0, 1, 0), { direction: new THREE.Vector3(1, 0, 0) });
    applyDab('comb', f, mesh, d, defaultBrush(), rec.touch);
    applyDab('comb', f, mesh, d, defaultBrush(), rec.touch);
    const change = rec.finish('layer', 'comb')!;
    expect(new Set(change.indices).size).toBe(change.indices.length);
    writeValues(f, change, change.before);
    expect(Array.from(f.flow)).toEqual(Array.from(before));
  });

  it('keeps just the changed vertices of a whole-map edit, and undoes it exactly', () => {
    const f = createFields(mesh.count);
    f.length.fill(0.05);
    for (let i = 0; i < mesh.count; i++) f.flow.set([0, 0, 1], i * 3);
    const channels = ['length', 'flow'] as const;
    const before = channels.map((ch) => f[ch].slice());
    f.length[3] = 0.2;
    f.flow[7 * 3] = 1;
    const change = diffChange(f, 'layer', 'edit', [...channels], before)!;
    expect(Array.from(change.indices)).toEqual([3, 7]);
    expect(change.before[1].length).toBe(6);
    const after = channels.map((ch) => f[ch].slice());
    writeValues(f, change, change.before);
    expect(Array.from(f.length)).toEqual(Array.from(before[0]));
    expect(Array.from(f.flow)).toEqual(Array.from(before[1]));
    writeValues(f, change, change.after);
    expect(Array.from(f.length)).toEqual(Array.from(after[0]));
    expect(Array.from(f.flow)).toEqual(Array.from(after[1]));
    expect(diffChange(f, 'layer', 'edit', [...channels], after)).toBeNull();
  });

  it('never paints a length the saved groom cannot hold', () => {
    const f = createFields(mesh.count);
    f.length.fill(0.05);
    const brush = { ...defaultBrush(), strength: 1, value: { ...defaultBrush().value, length: 5 } };
    for (let k = 0; k < 20; k++)
      applyDab('length', f, mesh, dabAt(new THREE.Vector3(0, 1, 0)), brush, () => {});
    expect(Math.max(...f.length)).toBeLessThanOrEqual(MAP_LENGTH_MAX);
    expect(Math.max(...f.length)).toBeGreaterThan(1.9);
  });
});
