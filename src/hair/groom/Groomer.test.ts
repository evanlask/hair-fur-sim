import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { ColliderSet } from '../colliders';
import { buildGroom, buildGroomGroup, reshapeGroomGroup } from './Groomer';
import { createBallStyle, defaultBallStyle } from './styles/ballStyle';
import { SurfaceSampler } from './SurfaceSampler';
import type { GroomData, GroomStyle, GrowthMesh } from './types';

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

/** FNV-1a over integers (floats quantized to 1e-6), so the hash pins the data, not float noise. */
function checksum(arrays: (Float32Array | Uint32Array)[]): string {
  let h = 2166136261;
  const mix = (x: number) => {
    h = Math.imul(h ^ (x >>> 0), 16777619);
    h = Math.imul(h ^ (Math.floor(x / 4294967296) >>> 0), 16777619);
  };
  for (const a of arrays) {
    mix(a.length);
    const float = a instanceof Float32Array;
    for (let i = 0; i < a.length; i++) mix(float ? Math.round(a[i] * 1e6) : a[i]);
  }
  return (h >>> 0).toString(16);
}

/** One hash per group over every array the GPU receives. */
function groomChecksums(groom: GroomData): string[] {
  return groom.groups.map((g) =>
    checksum([
      g.guides.rootTri,
      g.guides.rootBary,
      g.guides.rest,
      g.guides.initWorld,
      g.strands.guides,
      g.strands.weights,
      g.strands.rootTri,
      g.strands.rootBary,
    ]),
  );
}

const DOWN = new THREE.Vector3(0, -1, 0);

/** Two groups split at the equator, with waves, colours, density falloff and different resolutions. */
function twoGroupStyle(): GroomStyle {
  const tangent = new THREE.Vector3();
  return {
    groups: [
      {
        name: 'top',
        guideCount: 150,
        strandCount: 2000,
        guideParticles: 8,
        strandPoints: 10,
        lengthVariation: 0.3,
        widthVariation: 0.3,
        interpSpace: 'world',
      },
      {
        name: 'bottom',
        guideCount: 100,
        strandCount: 1500,
        guideParticles: 6,
        strandPoints: 8,
        lengthVariation: 0.2,
        widthVariation: 0.2,
        interpSpace: 'root',
      },
    ],
    density: (sp, g) => (g === 0 ? 0.5 + 0.5 * Math.max(0, sp.normal.y) : 1),
    group: (sp) => (sp.position.y > 0 ? 0 : 1),
    shape(sp, out, g) {
      const n = sp.normal;
      tangent.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
      if (tangent.lengthSq() < 1e-4) tangent.set(1, 0, 0).addScaledVector(n, -n.x);
      tangent.normalize();
      out.length = 0.05 + 0.1 * Math.abs(sp.position.x) + (g === 0 ? 0.04 : 0);
      out.direction.copy(n).multiplyScalar(0.4).addScaledVector(tangent, 0.6).normalize();
      out.bendTarget.copy(DOWN);
      out.bendRate = g === 0 ? 8 : 3;
      out.waveAmplitude = g === 0 ? 0.004 : 0;
      out.waveCount = 2;
    },
    color: (sp) => [Math.abs(sp.normal.x), 0.5, Math.abs(sp.normal.z)],
  };
}

/** A sphere shape on the growth surface and a capsule inside it (roots in it get masked). */
function testColliders(): ColliderSet {
  const c = new ColliderSet();
  c.setShape('sphere', new THREE.Vector4(0.2, 0, 0, 0), null);
  c.add({
    name: 'core',
    a: new THREE.Vector3(0, -0.05, 0),
    b: new THREE.Vector3(0, 0.05, 0),
    radius: 0.15,
    attach: null,
  });
  return c;
}

describe('groomer golden output', () => {
  // These pin the examples' grooms: only update the hashes for an intended change to grooming.
  it('ball style on a sphere', () => {
    const style = createBallStyle({
      ...defaultBallStyle(),
      guideCount: 300,
      strandCount: 3000,
      guideParticles: 8,
      strandPoints: 10,
    });
    expect(groomChecksums(buildGroom(sphereGrowth(), style, { seed: 5 }))).toEqual(['ce60b00f']);
  });

  it('two groups with colliders, waves, colours and quality scales', () => {
    const groom = buildGroom(sphereGrowth(), twoGroupStyle(), {
      seed: 3,
      colliders: testColliders(),
      collisionMargin: 0.003,
      strandScale: 0.5,
      guideScale: 0.8,
    });
    expect(groomChecksums(groom)).toEqual(['d9544381', 'b38d91e6']);
  });
});

/** Layered groups by name: 'top' grows above the equator, 'bottom' below; lengths scale with `lengthScale`. */
function namedStyle(names: string[], lengthScale = 1, seeds = true): GroomStyle {
  const base = twoGroupStyle();
  const specs = names.map((name) => ({
    ...base.groups[name === 'top' ? 0 : 1],
    name,
    seed: seeds ? 100 + (name === 'top' ? 1 : 2) : undefined,
    guideCount: name === 'top' ? 80 : 60,
  }));
  return {
    groups: specs,
    density: (sp, g) => ((specs[g].name === 'top') === sp.position.y > 0 ? 1 : 0),
    group: () => -1,
    shape(sp, out, g) {
      base.shape(sp, out, specs[g].name === 'top' ? 0 : 1);
      out.length *= lengthScale;
    },
  };
}

describe('groomer hooks', () => {
  const mesh = sphereGrowth();
  const opts = { seed: 3, colliders: testColliders(), collisionMargin: 0.003 };

  it('builds single groups like a full build', () => {
    const style = twoGroupStyle();
    const full = buildGroom(mesh, style, opts);
    const sampler = new SurfaceSampler(mesh);
    const single = buildGroomGroup(mesh, sampler, style, style.groups[1], 1, opts);
    expect(groomChecksums({ ...full, groups: [single] })).toEqual([groomChecksums(full)[1]]);
  });

  it('keeps the same output when recording roots', () => {
    const style = twoGroupStyle();
    const kept = buildGroom(mesh, style, { ...opts, keepRoots: true });
    expect(groomChecksums(kept)).toEqual(groomChecksums(buildGroom(mesh, style, opts)));
    for (const g of kept.groups) {
      expect(g.guideRoots).toHaveLength(g.guides.count);
      expect(g.guideDraws).toHaveLength(g.guides.count);
    }
    expect(buildGroom(mesh, style, opts).groups[0].guideRoots).toBeUndefined();
  });

  it('isolates groups with their own seeds from the others and their order', () => {
    const both = groomChecksums(buildGroom(mesh, namedStyle(['top', 'bottom']), opts));
    const swapped = groomChecksums(buildGroom(mesh, namedStyle(['bottom', 'top']), opts));
    const alone = groomChecksums(buildGroom(mesh, namedStyle(['bottom']), opts));
    expect(swapped).toEqual([both[1], both[0]]);
    expect(alone).toEqual([both[1]]);
    // Without their own seeds the streams follow the group's position.
    const unseeded = groomChecksums(buildGroom(mesh, namedStyle(['bottom', 'top'], 1, false), opts));
    expect(unseeded[0]).not.toEqual(both[1]);
  });

  it('reshapes to exactly the build when the style is unchanged', () => {
    const style = namedStyle(['top', 'bottom']);
    const groom = buildGroom(mesh, style, { ...opts, keepRoots: true });
    const before = groomChecksums(groom);
    expect(reshapeGroomGroup(mesh, style, groom.groups[0], 0, opts)).toBe(false);
    expect(reshapeGroomGroup(mesh, style, groom.groups[1], 1, opts, [0, 3, 5])).toBe(false);
    expect(groomChecksums(groom)).toEqual(before);
  });

  it('reshapes to the new style at the same roots and bindings', () => {
    const groom = buildGroom(mesh, namedStyle(['top', 'bottom']), { ...opts, keepRoots: true });
    const data = groom.groups[0];
    const bindings = checksum([data.strands.guides, data.strands.rootTri, data.strands.rootBary]);
    const longer = namedStyle(['top', 'bottom'], 1.5);
    expect(reshapeGroomGroup(mesh, longer, data, 0, opts)).toBe(true);
    // A fresh build of the longer style picks the same roots (they only depend on density).
    const fresh = buildGroom(mesh, longer, opts).groups[0];
    expect(checksum([data.guides.rootTri, data.guides.rootBary, data.guides.rest])).toBe(
      checksum([fresh.guides.rootTri, fresh.guides.rootBary, fresh.guides.rest]),
    );
    expect(checksum([data.strands.guides, data.strands.rootTri, data.strands.rootBary])).toBe(bindings);
    for (let s = 0; s < data.strands.count; s++)
      expect(data.strands.weights[s * 4 + 3]).toBeCloseTo(fresh.strands.weights[s * 4 + 3], 5);
    expect(data.maxLength).toBeCloseTo(fresh.maxLength, 6);
  });

  it('reshapes a subset of guides like a full reshape', () => {
    const style = namedStyle(['top']);
    const a = buildGroom(mesh, style, { ...opts, keepRoots: true }).groups[0];
    const b = buildGroom(mesh, style, { ...opts, keepRoots: true }).groups[0];
    const longer = namedStyle(['top'], 2);
    const subset = [1, 4, 9, 20];
    reshapeGroomGroup(mesh, longer, a, 0, opts, subset);
    reshapeGroomGroup(mesh, longer, b, 0, opts);
    const G = a.guides.particles;
    for (let i = 0; i < a.guides.count; i++) {
      const inSubset = subset.includes(i);
      const rest = (d: typeof a) => Array.from(d.guides.rest.subarray(i * G * 4, (i + 1) * G * 4));
      if (inSubset) expect(rest(a)).toEqual(rest(b));
      else expect(a.guides.rootBary[i * 4 + 3]).toBeCloseTo(b.guides.rootBary[i * 4 + 3] / 2, 6);
    }
  });
});
