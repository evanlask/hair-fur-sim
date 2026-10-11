import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { buildGroom } from '../Groomer';
import { SurfaceSampler, createSurfacePoint } from '../SurfaceSampler';
import type { GroomGroupSpec, GrowthMesh, GuideShape } from '../types';
import { createFields, createPaintedStyle, type PaintedFields } from './paintedStyle';

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

const mesh = sphereGrowth();
/** Fields per growth vertex here (no welding needed for the test). */
const identity = Int32Array.from({ length: mesh.vertexCount }, (_, i) => i);
const spec = (name: string, strands = 4000): GroomGroupSpec => ({
  name,
  guideCount: 200,
  strandCount: strands,
  guideParticles: 8,
  strandPoints: 8,
  lengthVariation: 0,
  widthVariation: 0,
  interpSpace: 'world',
});

function constantFields(): PaintedFields {
  const f = createFields(mesh.vertexCount);
  f.density.fill(1);
  f.length.fill(0.1);
  f.lift.fill(0.4);
  f.curve.fill(6);
  f.gravity.fill(0.5);
  f.wave.fill(0.002);
  for (let i = 0; i < mesh.vertexCount; i++) f.flow.set([0, -1, 0], i * 3);
  return f;
}

const newShape = (): GuideShape => ({
  length: 0,
  direction: new THREE.Vector3(),
  bendTarget: new THREE.Vector3(),
  bendRate: 0,
  waveAmplitude: 0,
  waveCount: 0,
});

describe('painted style', () => {
  const f = constantFields();
  const style = createPaintedStyle({
    layers: [{ spec: spec('a'), fields: f, lengthScale: 2, waveCount: 3 }],
    indices: mesh.indices,
    fieldIndex: identity,
    fieldToWorld: new THREE.Quaternion(),
  });
  const sampler = new SurfaceSampler(mesh);
  const sp = createSurfacePoint();

  it('reads the painted maps at a root', () => {
    sampler.evaluate(100, 0.2, 0.3, 0.5, sp);
    const out = newShape();
    style.shape(sp, out, 0);
    expect(out.length).toBeCloseTo(0.2, 6);
    expect(out.bendRate).toBeCloseTo(6, 6);
    expect(out.waveAmplitude).toBeCloseTo(0.002, 6);
    expect(out.waveCount).toBe(3);
    // Direction: the comb (down along the surface) lifted 40% of the way to the normal.
    const comb = new THREE.Vector3(0, -1, 0).addScaledVector(sp.normal, sp.normal.y).normalize();
    const expected = sp.normal.clone().multiplyScalar(0.4).addScaledVector(comb, 0.6).normalize();
    expect(out.direction.dot(expected)).toBeCloseTo(1, 5);
    // Bend target: half way from the comb to straight down.
    const target = comb
      .clone()
      .multiplyScalar(0.5)
      .add(new THREE.Vector3(0, -0.5, 0))
      .normalize();
    expect(out.bendTarget.dot(target)).toBeCloseTo(1, 5);
  });

  it('returns √density, and nothing where the bare mask is', () => {
    const half = createFields(mesh.vertexCount);
    half.density.fill(0.25);
    const bare = new Float32Array(mesh.vertexCount);
    bare.fill(1, 0, mesh.vertexCount / 2);
    const s = createPaintedStyle({
      layers: [{ spec: spec('a'), fields: half, lengthScale: 1, waveCount: 0 }],
      indices: mesh.indices,
      fieldIndex: identity,
      fieldToWorld: new THREE.Quaternion(),
      bare,
    });
    sampler.evaluate(mesh.triangleCount - 1, 1 / 3, 1 / 3, 1 / 3, sp);
    expect(s.density(sp, 0)).toBeCloseTo(0.5, 6);
    sampler.evaluate(0, 1 / 3, 1 / 3, 1 / 3, sp);
    expect(s.density(sp, 0)).toBe(0);
  });

  it('falls back to the nearest corner where opposite flows cancel (a parting)', () => {
    const p = constantFields();
    const t = 300;
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]);
    p.flow.set([1, 0, 0], a * 3);
    p.flow.set([-1, 0, 0], b * 3);
    p.flow.set([-1, 0, 0], c * 3);
    const s = createPaintedStyle({
      layers: [{ spec: spec('a'), fields: p, lengthScale: 1, waveCount: 0 }],
      indices: mesh.indices,
      fieldIndex: identity,
      fieldToWorld: new THREE.Quaternion(),
    });
    // At u = 0.5 the +x and −x flows cancel, so the nearest corner (a) decides.
    sampler.evaluate(t, 0.5, 0.25, 0.25, sp);
    const out = newShape();
    s.shape(sp, out, 0);
    expect(out.direction.x).toBeGreaterThan(0);
  });

  it('grows hair in proportion to the painted density', () => {
    const d = createFields(mesh.vertexCount);
    // Half density on top, full below.
    for (let i = 0; i < mesh.vertexCount; i++) d.density[i] = mesh.positions[i * 3 + 1] > 0 ? 0.5 : 1;
    const s = createPaintedStyle({
      layers: [{ spec: spec('a', 6000), fields: d, lengthScale: 1, waveCount: 0 }],
      indices: mesh.indices,
      fieldIndex: identity,
      fieldToWorld: new THREE.Quaternion(),
    });
    const groom = buildGroom(mesh, s, { seed: 2 });
    const st = groom.groups[0].strands;
    let top = 0;
    let bottom = 0;
    for (let i = 0; i < st.count; i++) {
      let y = 0;
      for (let k = 0; k < 3; k++) y += mesh.positions[st.rootTri[i * 4 + k] * 3 + 1] * st.rootBary[i * 4 + k];
      if (y > 0.02) top++;
      else if (y < -0.02) bottom++;
    }
    expect(top / bottom).toBeGreaterThan(0.42);
    expect(top / bottom).toBeLessThan(0.58);
  });
});
