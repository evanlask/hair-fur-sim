import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';

import { weldedNormals } from '../util/weld';
import type { GrowthMesh } from './groom/types';
import { bindPoseWorldPositions, type DeformSource } from './sim/deform';

function attrToFloat32(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  itemSize: number,
): Float32Array {
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = attr.getComponent(i, k);
  }
  return out;
}

/** World-space (bind pose) normals from local normals and an object's world matrix. */
function worldNormals(local: Float32Array, matrixWorld: THREE.Matrix4): Float32Array {
  const nm = new THREE.Matrix3().getNormalMatrix(matrixWorld);
  const out = new Float32Array(local.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < local.length / 3; i++) {
    v.fromArray(local, i * 3)
      .applyMatrix3(nm)
      .normalize();
    v.toArray(out, i * 3);
  }
  return out;
}

/** Growth mesh + deform source for a rigid (non-skinned) mesh. */
export function rigidGrowth(
  geometry: THREE.BufferGeometry,
  object: THREE.Object3D,
): { source: DeformSource; growth: GrowthMesh } {
  let g = geometry;
  if (!g.index) g = mergeVertices(g);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const localPositions = attrToFloat32(g.getAttribute('position'), 3);
  const localNormals = attrToFloat32(g.getAttribute('normal'), 3);
  const source: DeformSource = { kind: 'rigid', object, localPositions, localNormals };
  object.updateWorldMatrix(true, false);
  const positions = bindPoseWorldPositions(source);
  const normals = worldNormals(localNormals, object.matrixWorld);
  const uvAttr = g.getAttribute('uv');
  const indices = Uint32Array.from(g.index!.array as ArrayLike<number>);
  return {
    source,
    growth: {
      positions,
      normals,
      uvs: uvAttr ? attrToFloat32(uvAttr, 2) : null,
      indices,
      skinIndex: null,
      skinWeight: null,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    },
  };
}

/** Growth mesh + deform source for a skinned mesh (geometry must be indexed and welded). */
export function skinnedGrowth(
  mesh: THREE.SkinnedMesh,
  geometry: THREE.BufferGeometry,
): { source: DeformSource; growth: GrowthMesh } {
  const localPositions = attrToFloat32(geometry.getAttribute('position'), 3);
  const si = geometry.getAttribute('skinIndex');
  const sw = geometry.getAttribute('skinWeight');
  const skinIndex = new Uint32Array(si.count * 4);
  for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) skinIndex[i * 4 + k] = si.getComponent(i, k);
  const skinWeight = attrToFloat32(sw, 4);
  const localNormals = weldedNormals(localPositions, geometry.index!.array as ArrayLike<number>);
  const source: DeformSource = { kind: 'skinned', mesh, localPositions, localNormals, skinIndex, skinWeight };
  const positions = bindPoseWorldPositions(source);
  // Smooth normals from the bind-pose world positions, welded across UV seams.
  const normals = weldedNormals(positions, geometry.index!.array as ArrayLike<number>);
  const uvAttr = geometry.getAttribute('uv');
  const indices = Uint32Array.from(geometry.index!.array as ArrayLike<number>);
  return {
    source,
    growth: {
      positions,
      normals,
      uvs: uvAttr ? attrToFloat32(uvAttr, 2) : null,
      indices,
      skinIndex,
      skinWeight,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    },
  };
}
