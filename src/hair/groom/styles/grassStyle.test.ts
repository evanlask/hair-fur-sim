import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { rigidGrowth } from '../../growth';
import { buildGroom } from '../Groomer';
import { createSurfacePoint } from '../SurfaceSampler';
import { createGrassStyle, defaultGrassStyle, GRASS_GROUP, STALK_GROUP } from './grassStyle';

describe('grass style', () => {
  const params = {
    ...defaultGrassStyle(),
    radius: 1.5,
    fade: 0.4,
    guideCount: 400,
    strandCount: 4000,
    stalkGuides: 80,
    stalkStrands: 300,
  };
  const style = createGrassStyle(params);
  const geometry = new THREE.PlaneGeometry(3, 3, 60, 60).rotateX(-Math.PI / 2);
  const { growth } = rigidGrowth(geometry, new THREE.Object3D());
  const groom = buildGroom(growth, style, { seed: 2 });
  const [grass, stalks] = groom.groups;

  it('grows both layered groups over the same ground', () => {
    expect(grass.guides.count).toBeGreaterThan(params.guideCount * 0.8);
    expect(grass.strands.count).toBe(params.strandCount);
    expect(stalks.guides.count).toBeGreaterThan(params.stalkGuides * 0.8);
    expect(stalks.strands.count).toBe(params.stalkStrands);
  });

  it('keeps every root inside the field radius', () => {
    for (const g of groom.groups) {
      const w = g.guides.initWorld;
      for (let i = 0; i < g.guides.count; i++) {
        const o = i * g.guides.particles * 4;
        expect(Math.hypot(w[o], w[o + 2])).toBeLessThan(params.radius);
      }
    }
  });

  it('has density 0 outside the field', () => {
    const sp = createSurfacePoint();
    sp.position.set(params.radius + 0.01, 0, 0);
    expect(style.density(sp, GRASS_GROUP)).toBe(0);
    expect(style.density(sp, STALK_GROUP)).toBe(0);
  });

  it('grows short blades upward and taller stalks', () => {
    expect(grass.maxLength).toBeLessThan(0.4);
    expect(stalks.maxLength).toBeGreaterThan(grass.maxLength);
    expect(stalks.maxLength).toBeLessThanOrEqual(0.85);
    // Tips stand above their roots.
    const w = grass.guides.initWorld;
    const G = grass.guides.particles;
    for (let i = 0; i < grass.guides.count; i++) expect(w[(i * G + G - 1) * 4 + 1]).toBeGreaterThan(0);
  });

  it('bakes colours within [0, 1]', () => {
    const sp = createSurfacePoint();
    for (let i = 0; i < 300; i++) {
      sp.position.set(Math.sin(i) * 1.4, 0, Math.cos(i * 1.7) * 1.4);
      for (const g of [GRASS_GROUP, STALK_GROUP]) {
        const c = style.color!(sp, g)!;
        for (const v of c) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
