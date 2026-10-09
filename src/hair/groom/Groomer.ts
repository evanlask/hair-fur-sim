import * as THREE from 'three/webgpu';

import { Rng, shuffledIndices } from '../../util/rng';
import type { ColliderSet } from '../colliders';
import { SpatialHash } from './SpatialHash';
import { SurfaceSampler, createSurfacePoint, copySurfacePoint } from './SurfaceSampler';
import type {
  GroomData,
  GroomGroupData,
  GroomGroupSpec,
  GroomStyle,
  GrowthMesh,
  GuideData,
  GuideShape,
  StrandData,
  SurfacePoint,
} from './types';

export interface GroomOptions {
  seed?: number;
  /** Colliders evaluated in bind pose: used to bake collider masks and push guides out. */
  colliders?: ColliderSet | null;
  collisionMargin?: number;
  /** Multiplies render strand counts (quality presets). */
  strandScale?: number;
  /** Multiplies guide counts. */
  guideScale?: number;
  /** Fraction of the strand where root-containing colliders are ignored (matches the solver). */
  rootColliderRange?: number;
}

const ROOT_OFFSET = 0.0002;

/** Builds guide + render strand data for every group of a style. */
export function buildGroom(mesh: GrowthMesh, style: GroomStyle, opts: GroomOptions = {}): GroomData {
  const sampler = new SurfaceSampler(mesh);
  const groups: GroomGroupData[] = [];
  const bounds = new THREE.Box3();
  let maxLen = 0;
  style.groups.forEach((spec, gi) => {
    const data = buildGroup(mesh, sampler, style, spec, gi, opts);
    groups.push(data);
    maxLen = Math.max(maxLen, data.maxLength);
    const w = data.guides.initWorld;
    for (let i = 0; i < data.guides.count * data.guides.particles; i++) {
      bounds.expandByPoint(new THREE.Vector3(w[i * 4], w[i * 4 + 1], w[i * 4 + 2]));
    }
  });
  const sphere = bounds.isEmpty() ? new THREE.Sphere() : bounds.getBoundingSphere(new THREE.Sphere());
  return { groups, boundsCenter: sphere.center, boundsRadius: sphere.radius + maxLen * 0.25 };
}

function triangleWeightFn(
  sampler: SurfaceSampler,
  style: GroomStyle,
  group: number,
): (tri: number) => number {
  const sp = createSurfacePoint();
  const corners: [number, number, number][] = [
    [1 / 3, 1 / 3, 1 / 3],
    [0.8, 0.1, 0.1],
    [0.1, 0.8, 0.1],
    [0.1, 0.1, 0.8],
  ];
  return (tri: number) => {
    let best = 0;
    for (const [u, v, w] of corners) {
      sampler.evaluate(tri, u, v, w, sp);
      const g = style.group(sp);
      if (g !== group && g !== -1) continue;
      best = Math.max(best, style.density(sp, group));
    }
    return best;
  };
}

/** Rejection test for an exact sample point. */
function accept(style: GroomStyle, group: number, sp: SurfacePoint, rng: Rng): boolean {
  const g = style.group(sp);
  if (g !== group && g !== -1) return false;
  const d = style.density(sp, group);
  return d > 0 && rng.next() < d;
}

function buildGroup(
  mesh: GrowthMesh,
  sampler: SurfaceSampler,
  style: GroomStyle,
  spec: GroomGroupSpec,
  group: number,
  opts: GroomOptions,
): GroomGroupData {
  // Separate deterministic stream per group, so editing one group doesn't reshuffle the others.
  const rng = new Rng((opts.seed ?? 1) * 7919 + group * 104729);
  sampler.setWeights(triangleWeightFn(sampler, style, group));
  const area = sampler.totalWeightedArea;
  const guideTarget = Math.max(1, Math.round(spec.guideCount * (opts.guideScale ?? 1)));
  const strandTarget = Math.max(1, Math.round(spec.strandCount * (opts.strandScale ?? 1)));

  // Guides: Poisson-disk dart throwing over the masked surface. Dart throwing jams at ~1.436·r² of area per
  // point (54.7% disk coverage), so this r just fits the target. 0.85 leaves headroom; r shrinks if stuck.
  let radius = 0.85 * Math.sqrt(area / (1.436 * guideTarget));
  const guideHash = new SpatialHash(Math.max(radius, 1e-4) * 2, guideTarget);
  const guidePoints: SurfacePoint[] = [];
  const sp = createSurfacePoint();
  let attempts = 0;
  const maxAttempts = guideTarget * 60;
  while (guidePoints.length < guideTarget && attempts < maxAttempts * 3) {
    attempts++;
    if (attempts % maxAttempts === 0) radius *= 0.8;
    if (!sampler.sample(rng, sp) || !accept(style, group, sp, rng)) continue;
    if (guideHash.anyWithin(sp.position.x, sp.position.y, sp.position.z, radius)) continue;
    guideHash.insert(sp.position.x, sp.position.y, sp.position.z);
    guidePoints.push(copySurfacePoint(sp, createSurfacePoint()));
  }
  const guides = buildGuides(mesh, style, spec, group, guidePoints, opts, rng);

  // Render strands: random roots bound to the 3 nearest guides of the group.
  const strands = bindStrands(
    mesh,
    sampler,
    style,
    spec,
    group,
    strandTarget,
    guidePoints,
    guideHash,
    guides,
    rng,
  );

  let maxLength = 0;
  for (let g = 0; g < guides.count; g++) maxLength = Math.max(maxLength, guides.rootBary[g * 4 + 3]);
  return { spec, guides, strands, maxLength };
}

const tmp = {
  p0: new THREE.Vector3(),
  p1: new THREE.Vector3(),
  p2: new THREE.Vector3(),
  t: new THREE.Vector3(),
  b: new THREE.Vector3(),
  n: new THREE.Vector3(),
  d: new THREE.Vector3(),
  side: new THREE.Vector3(),
};

/**
 * Smooth root frame in bind pose: normal = barycentric blend of vertex normals, tangent = first triangle edge
 * orthogonalised against it. Guide rest positions are stored in this frame, so it must match `rootNormal` +
 * `orthoFrame` in sim/tslUtil.ts.
 */
export function smoothFrame(
  mesh: GrowthMesh,
  tri: number,
  u: number,
  v: number,
  w: number,
  t: THREE.Vector3,
  b: THREE.Vector3,
  n: THREE.Vector3,
): void {
  const { positions: p, normals: nn, indices: idx } = mesh;
  const i0 = idx[tri * 3];
  const i1 = idx[tri * 3 + 1];
  const i2 = idx[tri * 3 + 2];
  n.set(
    nn[i0 * 3] * u + nn[i1 * 3] * v + nn[i2 * 3] * w,
    nn[i0 * 3 + 1] * u + nn[i1 * 3 + 1] * v + nn[i2 * 3 + 1] * w,
    nn[i0 * 3 + 2] * u + nn[i1 * 3 + 2] * v + nn[i2 * 3 + 2] * w,
  ).normalize();
  tmp.p0.fromArray(p, i0 * 3);
  tmp.p1.fromArray(p, i1 * 3);
  tmp.p2.fromArray(p, i2 * 3);
  // Thin features (ears): welded normals cancel, so fall back to the face normal.
  const e1 = tmp.d.copy(tmp.p1).sub(tmp.p0);
  const faceN = tmp.side.copy(tmp.p2).sub(tmp.p0).cross(e1).negate().normalize();
  if (faceN.lengthSq() > 0 && n.dot(faceN) < 0.3) n.copy(faceN);
  t.copy(tmp.p1).sub(tmp.p0);
  t.addScaledVector(n, -n.dot(t)).normalize();
  b.crossVectors(n, t);
}

function buildGuides(
  mesh: GrowthMesh,
  style: GroomStyle,
  spec: GroomGroupSpec,
  group: number,
  points: SurfacePoint[],
  opts: GroomOptions,
  rng: Rng,
): GuideData {
  const N = points.length;
  const G = spec.guideParticles;
  const rootTri = new Uint32Array(N * 4);
  const rootBary = new Float32Array(N * 4);
  const rest = new Float32Array(N * G * 4);
  const initWorld = new Float32Array(N * G * 4);
  const shape: GuideShape = {
    length: 0.1,
    direction: new THREE.Vector3(),
    bendTarget: new THREE.Vector3(0, -1, 0),
    bendRate: 0,
    waveAmplitude: 0,
    waveCount: 0,
  };
  const colliders = opts.colliders ?? null;
  const margin = opts.collisionMargin ?? 0.004;
  const rootColliderRange = opts.rootColliderRange ?? 0.25;
  const xs = Array.from({ length: G }, () => new THREE.Vector3());
  const dir = new THREE.Vector3();
  const target = new THREE.Vector3();

  for (let g = 0; g < N; g++) {
    const p = points[g];
    shape.bendRate = 0;
    shape.waveAmplitude = 0;
    shape.waveCount = 0;
    shape.bendTarget.set(0, -1, 0);
    style.shape(p, shape, group);
    const L = Math.max(shape.length, 1e-4);
    const h = L / (G - 1);

    // Collider mask: disable capsules that already contain the root region. Only 32 bits, so capsules beyond
    // that always collide (as in sim/collide.ts).
    let mask = 0xffffffff;
    if (colliders) {
      for (let c = 0; c < Math.min(colliders.capsules.length, 32); c++) {
        if (colliders.capsuleDistance(c, p.position) < margin + h * 0.5) mask &= ~(1 << c);
      }
    }

    xs[0].copy(p.position).addScaledVector(p.normal, ROOT_OFFSET);
    dir.copy(shape.direction).normalize();
    // Never start growing into or flat along the surface.
    if (dir.dot(p.normal) < 0.05) dir.addScaledVector(p.normal, 0.05 - dir.dot(p.normal)).normalize();
    tmp.side.crossVectors(dir, p.normal);
    if (tmp.side.lengthSq() < 1e-8) tmp.side.set(1, 0, 0).cross(p.normal);
    tmp.side.normalize();
    const wavePhase = rng.next() * Math.PI * 2;
    for (let k = 1; k < G; k++) {
      const bend = 1 - Math.exp(-shape.bendRate * h);
      target.copy(shape.bendTarget);
      dir.lerp(target, bend).normalize();
      const next = xs[k].copy(xs[k - 1]).addScaledVector(dir, h);
      if (shape.waveAmplitude > 0) {
        // Ramps in over the first quarter so the root isn't displaced.
        const off = (s: number) =>
          shape.waveAmplitude * Math.min(1, s * 4) * Math.sin(wavePhase + s * shape.waveCount * Math.PI * 2);
        next.addScaledVector(tmp.side, off(k / (G - 1)) - off((k - 1) / (G - 1)));
      }
      // The first two particles are pinned to the root frame by the solver.
      if (colliders && k >= 2)
        colliders.pushOut(next, k / (G - 1) < rootColliderRange ? mask : 0xffffffff, margin * 1.5);
      // Keep near-root particles above the surface plane.
      const above = tmp.d.copy(next).sub(p.position).dot(p.normal);
      const minAbove = Math.min(k * h * 0.15, 0.01);
      if (k <= 3 && above < minAbove) next.addScaledVector(p.normal, minAbove - above);
      // Re-project to the segment length and update the growth direction.
      tmp.d.copy(next).sub(xs[k - 1]);
      const len = tmp.d.length();
      if (len > 1e-9) tmp.d.multiplyScalar(h / len);
      else tmp.d.copy(p.normal).multiplyScalar(h);
      next.copy(xs[k - 1]).add(tmp.d);
      dir.copy(tmp.d).normalize();
    }

    smoothFrame(mesh, p.tri, p.u, p.v, p.w, tmp.t, tmp.b, tmp.n);
    const i0 = mesh.indices[p.tri * 3];
    const i1 = mesh.indices[p.tri * 3 + 1];
    const i2 = mesh.indices[p.tri * 3 + 2];
    rootTri.set([i0, i1, i2, mask >>> 0], g * 4);
    rootBary.set([p.u, p.v, p.w, L], g * 4);
    for (let k = 0; k < G; k++) {
      const o = (g * G + k) * 4;
      tmp.d.copy(xs[k]).sub(p.position);
      rest[o] = tmp.d.dot(tmp.t);
      rest[o + 1] = tmp.d.dot(tmp.b);
      rest[o + 2] = tmp.d.dot(tmp.n);
      rest[o + 3] = k === 0 ? 0 : xs[k].distanceTo(xs[k - 1]);
      initWorld[o] = xs[k].x;
      initWorld[o + 1] = xs[k].y;
      initWorld[o + 2] = xs[k].z;
      initWorld[o + 3] = 1;
    }
  }
  return { count: N, particles: G, rootTri, rootBary, rest, initWorld };
}

/** RGBA8 with gamma 2.2 (decoded in sim/shade.ts). White means no baked color. */
function packColor(rgb: [number, number, number] | null): number {
  if (!rgb) return 0xffffffff;
  const enc = (c: number) => Math.round(Math.pow(Math.min(Math.max(c, 0), 1), 1 / 2.2) * 255);
  return (enc(rgb[0]) | (enc(rgb[1]) << 8) | (enc(rgb[2]) << 16) | (255 << 24)) >>> 0;
}

function bindStrands(
  mesh: GrowthMesh,
  sampler: SurfaceSampler,
  style: GroomStyle,
  spec: GroomGroupSpec,
  group: number,
  target: number,
  guidePoints: SurfacePoint[],
  guideHash: SpatialHash,
  guides: GuideData,
  rng: Rng,
): StrandData {
  const roots: { p: SurfacePoint; g: [number, number, number]; w: [number, number, number] }[] = [];
  const sp = createSurfacePoint();
  const cand: { id: number; d2: number }[] = [];
  let attempts = 0;
  while (roots.length < target && attempts < target * 40) {
    attempts++;
    if (!sampler.sample(rng, sp) || !accept(style, group, sp, rng)) continue;
    cand.length = 0;
    // Widen the search until there are 3 candidates. The normal test skips guides on the far side of thin
    // features (the other face of an ear).
    for (let ring = 1; ring <= 4 && cand.length < 3; ring++) {
      cand.length = 0;
      guideHash.forEachNear(sp.position.x, sp.position.y, sp.position.z, ring, (id, d2) => {
        if (guidePoints[id].normal.dot(sp.normal) > 0.1) cand.push({ id, d2 });
      });
    }
    if (cand.length === 0) {
      // Fall back to any guide (brute force) for isolated islands.
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < guidePoints.length; i++) {
        const d2 = guidePoints[i].position.distanceToSquared(sp.position);
        if (d2 < bestD) {
          bestD = d2;
          best = i;
        }
      }
      if (best < 0) continue;
      cand.push({ id: best, d2: bestD });
    }
    cand.sort((a, b) => a.d2 - b.d2);
    const g: [number, number, number] = [
      cand[0].id,
      cand[Math.min(1, cand.length - 1)].id,
      cand[Math.min(2, cand.length - 1)].id,
    ];
    // Inverse squared distance weights; eps keeps a root sitting on a guide from dominating with infinity.
    const eps = guideHash.cellSize * guideHash.cellSize * 0.01;
    const w: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      if (k >= cand.length) continue;
      w[k] = 1 / (cand[k].d2 + eps);
    }
    const sum = w[0] + w[1] + w[2];
    roots.push({ p: copySurfacePoint(sp, createSurfacePoint()), g, w: [w[0] / sum, w[1] / sum, w[2] / sum] });
  }

  const N = roots.length;
  // Shuffled so any prefix is a uniform subset: LOD thinning only draws the first strands.
  const order = shuffledIndices(N, rng);
  const out: StrandData = {
    count: N,
    points: spec.strandPoints,
    guides: new Uint32Array(N * 4),
    weights: new Float32Array(N * 4),
    rootTri: new Uint32Array(N * 4),
    rootBary: new Float32Array(N * 4),
  };
  for (let i = 0; i < N; i++) {
    const r = roots[order[i]];
    const lam = 1 - spec.lengthVariation * rng.next();
    const L =
      lam *
      (r.w[0] * guides.rootBary[r.g[0] * 4 + 3] +
        r.w[1] * guides.rootBary[r.g[1] * 4 + 3] +
        r.w[2] * guides.rootBary[r.g[2] * 4 + 3]);
    const width = 1 + spec.widthVariation * (rng.next() * 2 - 1);
    const tri = r.p.tri;
    out.guides.set([r.g[0], r.g[1], r.g[2], rng.uint()], i * 4);
    out.weights.set([r.w[0], r.w[1], r.w[2], L], i * 4);
    out.rootTri.set(
      [
        mesh.indices[tri * 3],
        mesh.indices[tri * 3 + 1],
        mesh.indices[tri * 3 + 2],
        packColor(style.color?.(r.p, group) ?? null),
      ],
      i * 4,
    );
    out.rootBary.set([r.p.u, r.p.v, r.p.w, Math.max(0.05, width)], i * 4);
  }
  return out;
}
