import { tsl } from './tsl';

const { Fn, cross, dot, float, length, max, select, vec3 } = tsl;

// Loose node type for kernel code (see tsl.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;

/** v / |v|, or `fallback` when |v| is (nearly) zero. */
export const safeNormalize = Fn(([v, fallback]: [N, N]) => {
  const l = length(v);
  return select(l.greaterThan(1e-8), v.div(max(l, 1e-8)), fallback);
}).setLayout({
  name: 'safeNormalize',
  type: 'vec3',
  inputs: [
    { name: 'v', type: 'vec3' },
    { name: 'fallback', type: 'vec3' },
  ],
});

/**
 * Applies the minimal rotation taking unit vector a onto unit vector b to v
 * (Rodrigues without trig): v' = c·v + w×v + (w·v)/(1+c)·w, with w = a×b, c = a·b.
 */
export const rotateFromTo = Fn(([a, b, v]: [N, N, N]) => {
  const c = dot(a, b);
  const w = cross(a, b);
  const k = float(1).div(max(c.add(1), 1e-4));
  return v
    .mul(c)
    .add(cross(w, v))
    .add(w.mul(dot(w, v).mul(k)));
}).setLayout({
  name: 'rotateFromTo',
  type: 'vec3',
  inputs: [
    { name: 'a', type: 'vec3' },
    { name: 'b', type: 'vec3' },
    { name: 'v', type: 'vec3' },
  ],
});

/** Uniform Catmull-Rom spline through p1..p2 (p0/p3 are neighbours), t in [0,1]. */
export const catmullRom = Fn(([p0, p1, p2, p3, t]: [N, N, N, N, N]) => {
  const t2 = t.mul(t);
  const t3 = t2.mul(t);
  const a = p1.mul(2);
  const b = p2.sub(p0).mul(t);
  const c = p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3).mul(t2);
  const d = p0.negate().add(p1.mul(3)).sub(p2.mul(3)).add(p3).mul(t3);
  return a.add(b).add(c).add(d).mul(0.5);
}).setLayout({
  name: 'catmullRom',
  type: 'vec3',
  inputs: [
    { name: 'p0', type: 'vec3' },
    { name: 'p1', type: 'vec3' },
    { name: 'p2', type: 'vec3' },
    { name: 'p3', type: 'vec3' },
    { name: 't', type: 'float' },
  ],
});

/** Orthonormal frame (t, b, n) that keeps the normal's direction; the tangent is projected onto its plane. */
export function orthoFrame(tIn: N, nIn: N): { t: N; b: N; n: N } {
  const n = safeNormalize(nIn, vec3(0, 1, 0)).toVar();
  const t = safeNormalize(tIn.sub(n.mul(dot(n, tIn))), vec3(1, 0, 0)).toVar();
  const b = cross(n, t).toVar();
  return { t, b, n };
}

export function frameToWorld(origin: N, f: { t: N; b: N; n: N }, l: N): N {
  return origin.add(f.t.mul(l.x)).add(f.b.mul(l.y)).add(f.n.mul(l.z));
}

/** Frame rotation only (vector in local coords → world direction). */
export function frameRotate(f: { t: N; b: N; n: N }, l: N): N {
  return f.t.mul(l.x).add(f.b.mul(l.y)).add(f.n.mul(l.z));
}

export function frameToLocal(origin: N, f: { t: N; b: N; n: N }, x: N): N {
  const d = x.sub(origin);
  return vec3(dot(d, f.t), dot(d, f.b), dot(d, f.n));
}

/**
 * Root normal: barycentric blend of vertex normals, falling back to the face normal where they
 * disagree strongly (thin features like ears, whose welded normals cancel). Mirrors the CPU versions in
 * Groomer.smoothFrame and SurfaceSampler.evaluate.
 */
export function rootNormal(P0: N, P1: N, P2: N, nBlend: N): N {
  const nI = safeNormalize(nBlend, vec3(0, 1, 0));
  const nF = safeNormalize(cross(P1.sub(P0), P2.sub(P0)), nI);
  return select(dot(nI, nF).lessThan(0.3), nF, nI);
}
