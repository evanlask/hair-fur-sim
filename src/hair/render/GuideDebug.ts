import * as THREE from 'three/webgpu';

import { tsl } from '../sim/tsl';
import type { N } from '../sim/tslUtil';

const { Fn, color, float, mix, uint, varyingProperty, vertexIndex } = tsl;

/** Debug view of the simulated guide strands as line segments (root = orange, tip = cyan). */
export function createGuideDebug(guidePos: N, Ng: number, G: number): THREE.LineSegments {
  const segments = Ng * (G - 1);
  const geometry = new THREE.BufferGeometry();
  // Only the vertex count matters: positions are read from guidePos in the vertex shader.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 2 * 3), 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const material = new THREE.LineBasicNodeMaterial({ depthTest: true, transparent: false });
  const vS = varyingProperty('float', 'vGuideS') as N;
  material.positionNode = (
    Fn(() => {
      const v = vertexIndex;
      const seg = v.div(uint(2));
      const end = v.mod(uint(2));
      const g = seg.div(uint(G - 1));
      const k = seg.mod(uint(G - 1)).add(end);
      vS.assign(float(k).div(G - 1));
      return guidePos.element(g.mul(uint(G)).add(k)).xyz;
    }) as N
  )();
  material.colorNode = mix(color(0xff7a2f), color(0x4fe8ff), vS);
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.name = 'guides';
  lines.renderOrder = 2;
  return lines;
}
