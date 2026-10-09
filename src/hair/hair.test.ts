import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { Rng, shuffledIndices } from '../util/rng';
import { weldedNormals } from '../util/weld';
import { buildGroom, smoothFrame } from './groom/Groomer';
import { SpatialHash } from './groom/SpatialHash';
import { createBallStyle, defaultBallStyle } from './groom/styles/ballStyle';
import { SurfaceSampler, createSurfacePoint } from './groom/SurfaceSampler';
import type { GrowthMesh } from './groom/types';
import { buildParticleProfile, defaultPhysics, HairUniforms, mergeHairParams, DT_REF } from './params';
import { equirectToIrradianceSH, shBasis } from './render/envSH';

function sphereGrowth(radius = 0.2): GrowthMesh {
  const g = new THREE.SphereGeometry(radius, 32, 24);
  const positions = Float32Array.from(g.getAttribute('position').array as ArrayLike<number>);
  const normals = Float32Array.from(g.getAttribute('normal').array as ArrayLike<number>);
  const indices = Uint32Array.from(g.index!.array as ArrayLike<number>);
  return {
    positions,
    normals,
    uvs: Float32Array.from(g.getAttribute('uv').array as ArrayLike<number>),
    indices,
    skinIndex: null,
    skinWeight: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

describe('rng', () => {
  it('is deterministic per seed and in [0,1)', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('shuffles into a permutation', () => {
    const idx = shuffledIndices(1000, new Rng(1));
    expect(new Set(idx).size).toBe(1000);
    expect(Math.max(...idx)).toBe(999);
  });
});

describe('spatial hash', () => {
  it('finds points within radius', () => {
    const h = new SpatialHash(0.1, 10);
    h.insert(0, 0, 0);
    h.insert(1, 1, 1);
    expect(h.anyWithin(0.05, 0, 0, 0.06)).toBe(true);
    expect(h.anyWithin(0.5, 0.5, 0.5, 0.06)).toBe(false);
  });
});

describe('surface sampler', () => {
  it('returns valid barycentrics on the surface', () => {
    const mesh = sphereGrowth(0.2);
    const s = new SurfaceSampler(mesh);
    const rng = new Rng(3);
    const sp = createSurfacePoint();
    for (let i = 0; i < 200; i++) {
      expect(s.sample(rng, sp)).toBe(true);
      expect(sp.u + sp.v + sp.w).toBeCloseTo(1, 5);
      expect(Math.min(sp.u, sp.v, sp.w)).toBeGreaterThanOrEqual(-1e-6);
      // Points lie close to the sphere (flat triangles are slightly inside).
      expect(sp.position.length()).toBeGreaterThan(0.19);
      expect(sp.position.length()).toBeLessThanOrEqual(0.2 + 1e-5);
      expect(sp.normal.length()).toBeCloseTo(1, 4);
    }
  });
});

describe('groomer', () => {
  const mesh = sphereGrowth(0.2);
  const params = {
    ...defaultBallStyle(),
    guideCount: 300,
    strandCount: 3000,
    guideParticles: 8,
    strandPoints: 10,
  };
  const groom = buildGroom(mesh, createBallStyle(params), { seed: 5 });
  const group = groom.groups[0];

  it('places roughly the requested number of guides and strands', () => {
    expect(group.guides.count).toBeGreaterThan(params.guideCount * 0.9);
    expect(group.guides.count).toBeLessThanOrEqual(params.guideCount);
    expect(group.strands.count).toBe(params.strandCount);
  });

  it('builds guides with consistent segment rest lengths', () => {
    const { rest, rootBary, particles: G, count } = group.guides;
    for (let g = 0; g < count; g++) {
      const L = rootBary[g * 4 + 3];
      let sum = 0;
      for (let k = 1; k < G; k++) sum += rest[(g * G + k) * 4 + 3];
      expect(sum).toBeCloseTo(L, 4);
      expect(rest[g * G * 4 + 3]).toBe(0);
    }
  });

  it('binds render strands with normalised weights and valid guide indices', () => {
    const { guides, weights, count } = group.strands;
    for (let i = 0; i < count; i++) {
      const w = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2];
      expect(w).toBeCloseTo(1, 4);
      for (let k = 0; k < 3; k++) expect(guides[i * 4 + k]).toBeLessThan(group.guides.count);
      expect(weights[i * 4 + 3]).toBeGreaterThan(0);
      expect(weights[i * 4 + 3]).toBeLessThanOrEqual(group.maxLength * (1 + 1e-4));
    }
  });

  it('computes orthonormal smooth root frames', () => {
    const t = new THREE.Vector3();
    const b = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let tri = 0; tri < mesh.triangleCount; tri += 37) {
      smoothFrame(mesh, tri, 0.2, 0.3, 0.5, t, b, n);
      if (n.lengthSq() === 0) continue;
      expect(t.length()).toBeCloseTo(1, 4);
      expect(b.length()).toBeCloseTo(1, 4);
      expect(n.length()).toBeCloseTo(1, 4);
      expect(t.dot(n)).toBeCloseTo(0, 4);
      expect(b.dot(n)).toBeCloseTo(0, 4);
    }
  });
});

describe('params', () => {
  it('builds a root→tip stiffness profile', () => {
    const p = defaultPhysics();
    const out = new Float32Array(8 * 4);
    buildParticleProfile(p, 8, out);
    // Per particle: global stiffness, local stiffness, s (0 at the root, 1 at the tip).
    expect(out[0]).toBeCloseTo(1);
    expect(out[7 * 4]).toBeCloseTo(p.globalTip);
    expect(out[7 * 4 + 2]).toBeCloseTo(1);
  });

  it('reaches the tip stiffness at the end of the hold range', () => {
    const p = { ...defaultPhysics(), globalTip: 0, globalCurve: 1, globalRange: 0.5 };
    const out = new Float32Array(9 * 4);
    buildParticleProfile(p, 9, out);
    expect(out[0]).toBeCloseTo(1);
    expect(out[2 * 4]).toBeCloseTo(0.5); // s = 0.25: halfway through the range
    expect(out[4 * 4]).toBeCloseTo(0); // s = 0.5: end of the range
    expect(out[8 * 4]).toBeCloseTo(0);
  });

  it('scales coefficients with the substep length', () => {
    const u = new HairUniforms();
    const params = mergeHairParams({ physics: { substeps: 4, damping: 2 } });
    u.sync(params);
    u.syncFrame(1 / 60, 0);
    expect(u.dtSub.value).toBeCloseTo(1 / 240);
    expect(u.stiffnessExponent.value).toBeCloseTo(1 / 240 / DT_REF);
    expect(u.dampingFactor.value).toBeCloseTo(Math.exp(-2 / 240));
  });

  describe('substep scheduling', () => {
    function uniformsWithSubsteps(substeps: number): HairUniforms {
      const u = new HairUniforms();
      u.sync(mergeHairParams({ physics: { substeps } }));
      return u;
    }

    /** Runs `frames` frames of length `dt`; returns simulated and real time and the per-frame substep counts. */
    function run(u: HairUniforms, dt: number, frames: number) {
      let simulated = 0;
      const counts: number[] = [];
      for (let f = 0; f < frames; f++) {
        u.syncFrame(dt, f * dt);
        simulated += u.substeps.value * u.dtSub.value;
        counts.push(u.substeps.value);
      }
      return { simulated, real: frames * dt, counts };
    }

    it.each([60, 120, 144, 90])('keeps simulated time in step with real time at %i Hz', (hz) => {
      const u = uniformsWithSubsteps(4);
      const { simulated, real } = run(u, 1 / hz, 600);
      expect(u.dtSub.value).toBeCloseTo(1 / 240);
      expect(Math.abs(simulated - real)).toBeLessThanOrEqual(1 / 240);
    });

    it('shortens substeps to one per frame on displays faster than the substep rate', () => {
      const u = uniformsWithSubsteps(4);
      run(u, 1 / 360, 300); // let the frame-time average settle
      const { simulated, real, counts } = run(u, 1 / 360, 360);
      expect(u.dtSub.value).toBeCloseTo(1 / 360);
      expect(new Set(counts)).toEqual(new Set([1]));
      expect(Math.abs(simulated - real)).toBeLessThanOrEqual(1 / 360);
    });

    it('caps a long stall instead of running a burst of substeps', () => {
      const u = uniformsWithSubsteps(4);
      run(u, 1 / 60, 120);
      u.syncFrame(0.5, 2);
      // Frame time is clamped to 1/15 s, i.e. 16 substeps of 1/240 s.
      expect(u.substeps.value).toBe(16);
      // And the stall isn't paid back over the following frames.
      const { counts } = run(u, 1 / 60, 10);
      expect(Math.max(...counts)).toBeLessThanOrEqual(5);
    });
  });
});

describe('environment SH', () => {
  it('projects a constant environment to constant irradiance', () => {
    const W = 64;
    const H = 32;
    const data = new Float32Array(W * H * 4).fill(0.5);
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    const sh = equirectToIrradianceSH(tex);
    for (const d of [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0.3, -0.5, 0.8).normalize(),
    ]) {
      const basis = shBasis(d.x, d.y, d.z);
      const r = sh.reduce((acc, c, k) => acc + c.x * basis[k], 0);
      expect(r).toBeCloseTo(0.5, 1);
    }
  });
});

describe('welded normals', () => {
  it('shares normals across duplicated seam vertices', () => {
    // Two triangles forming a folded quad (so their face normals differ), with the shared edge
    // duplicated (UV seam).
    const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0.5, 0, 1, 0]);
    const n = weldedNormals(p, [0, 1, 2, 3, 4, 5]);
    // Vertex 1 and 3 are the same position → same normal.
    expect(n[3]).toBeCloseTo(n[9]);
    expect(n[4]).toBeCloseTo(n[10]);
    expect(n[5]).toBeCloseTo(n[11]);
  });
});
