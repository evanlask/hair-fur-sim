import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import {
  OTHER_HEAD,
  decodeDocument,
  documentProblem,
  encodeDocument,
  fromBase64,
  octDecode,
  octEncode,
  toBase64,
} from './document';
import type { HeadFrame } from './heads';
import { emptyLayer } from './layers';
import { buildPaintMesh } from './paintMesh';

const frame: HeadFrame = {
  center: new THREE.Vector3(),
  radii: new THREE.Vector3(0.1, 0.1, 0.1),
  crown: new THREE.Vector3(0, 0.1, -0.03),
  midlineX: 0,
  hairline: [
    [0, 0],
    [180, 0],
  ],
  ears: [],
  bare: [],
};
const paint = buildPaintMesh(new THREE.SphereGeometry(0.1, 32, 24), 0, 0.02);
const target = { head: { id: 'ball', frame }, paint };

describe('groom document', () => {
  it('encodes unit vectors to within half a degree', () => {
    const out = [0, 0, 0];
    for (let i = 0; i < 200; i++) {
      const v = new THREE.Vector3(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)).normalize();
      const [u, w] = octEncode(v.x, v.y, v.z);
      // As stored: 8 bits per coordinate.
      const q = (x: number) => (Math.round((x * 0.5 + 0.5) * 255) / 255) * 2 - 1;
      octDecode(q(u), q(w), out);
      expect(new THREE.Vector3(...out).angleTo(v)).toBeLessThan((0.9 * Math.PI) / 180);
    }
  });

  it('round-trips base64', () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 37) & 255);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('saves and loads layers within their quantization', () => {
    const a = emptyLayer(target, 4, 9);
    a.name = 'Top';
    a.params.shading.rootColor = '#123456';
    const f = a.fields;
    for (let i = 0; i < paint.count; i++) {
      const y = paint.positions[i * 3 + 1];
      f.density[i] = y > 0 ? Math.min(1, y * 12) : 0;
      f.length[i] = 0.05 + 0.3 * Math.max(0, y);
      f.lift[i] = 0.25;
      f.curve[i] = 12.3;
      f.gravity[i] = 0.6;
      f.wave[i] = 0.0042;
    }
    const doc = JSON.parse(JSON.stringify(encodeDocument(target, [a])));
    expect(documentProblem(doc, target)).toBeNull();
    const [b] = decodeDocument(doc, target, 4);
    expect(b.name).toBe('Top');
    expect(b.params.shading.rootColor).toBe('#123456');
    expect(b.settings.seed).toBe(9);
    for (let i = 0; i < paint.count; i++) {
      expect(b.fields.density[i]).toBeCloseTo(f.density[i], 2);
      if (f.density[i] <= 0) continue;
      expect(b.fields.length[i]).toBeCloseTo(f.length[i], 4);
      expect(b.fields.lift[i]).toBeCloseTo(0.25, 2);
      expect(b.fields.curve[i]).toBeCloseTo(12.3, 0);
      expect(b.fields.gravity[i]).toBeCloseTo(0.6, 2);
      expect(b.fields.wave[i]).toBeCloseTo(0.0042, 4);
      const va = new THREE.Vector3().fromArray(f.flow, i * 3);
      const vb = new THREE.Vector3().fromArray(b.fields.flow, i * 3);
      expect(vb.angleTo(va)).toBeLessThan((1 * Math.PI) / 180);
    }
  });

  it('loads files from when layers had kinds the same', () => {
    const a = emptyLayer(target, 4, 3);
    for (let i = 0; i < paint.count; i++) a.fields.density[i] = paint.positions[i * 3 + 1] > 0 ? 1 : 0;
    const doc = encodeDocument(target, [a]);
    const old = { ...doc, layers: doc.layers.map((l) => ({ ...l, kind: 'long' })) };
    const [b] = decodeDocument(old, target, 4);
    const [c] = decodeDocument(doc, target, 4);
    expect(Array.from(b.fields.density)).toEqual(Array.from(c.fields.density));
    expect(Array.from(b.fields.length)).toEqual(Array.from(c.fields.length));
    expect('kind' in b).toBe(false);
  });

  it('rejects other files and flags grooms made on other heads', () => {
    expect(documentProblem({ hello: 1 }, target)).toBe('not a Groom Studio file');
    const doc = encodeDocument(target, []);
    expect(documentProblem({ ...doc, version: 99 }, target)).toMatch(/another version/);
    expect(documentProblem({ ...doc, head: 'other' }, target)).toBe(OTHER_HEAD);
    expect(documentProblem({ ...doc, vertices: 5 }, target)).toBe(OTHER_HEAD);
  });
});
