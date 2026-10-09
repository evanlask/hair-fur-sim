import * as THREE from 'three/webgpu';

import { tsl } from './tsl';
import type { N } from './tslUtil';

const { Fn, buffer, instanceIndex, instancedArray, normalize, uniform, vec4 } = tsl;

/** Where growth-mesh vertices come from each frame. */
export type DeformSource =
  | {
      kind: 'rigid';
      /** Object whose matrixWorld maps local positions to world. */
      object: THREE.Object3D;
      localPositions: Float32Array;
      localNormals: Float32Array;
    }
  | {
      kind: 'skinned';
      mesh: THREE.SkinnedMesh;
      localPositions: Float32Array;
      localNormals: Float32Array;
      skinIndex: Uint32Array;
      skinWeight: Float32Array;
    };

function toVec4(xyz: Float32Array, w = 1): Float32Array {
  const n = xyz.length / 3;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = xyz[i * 3];
    out[i * 4 + 1] = xyz[i * 3 + 1];
    out[i * 4 + 2] = xyz[i * 3 + 2];
    out[i * 4 + 3] = w;
  }
  return out;
}

/**
 * GPU stage that writes the current world-space positions and normals of the growth mesh vertices
 * (linear blend skinning or a rigid transform) into `deformed`. Normals go through the matrix itself rather
 * than its inverse transpose, which assumes uniform scale.
 */
export class GrowthDeformer {
  readonly vertexCount: number;
  /** Two vec4 per vertex: [2i] world position, [2i+1] world unit normal. */
  readonly deformed: N;
  readonly kernel: N;

  readonly source: DeformSource;
  /** Storage buffers owned by this deformer (freed by dispose). */
  private readonly buffers: N[];

  constructor(source: DeformSource) {
    this.source = source;
    const n = source.localPositions.length / 3;
    this.vertexCount = n;
    const local = instancedArray(toVec4(source.localPositions), 'vec4').toReadOnly() as N;
    const localN = instancedArray(toVec4(source.localNormals, 0), 'vec4').toReadOnly() as N;
    this.deformed = instancedArray(n * 2, 'vec4') as N;
    const out = this.deformed;
    this.buffers = [local, localN, out];

    if (source.kind === 'rigid') {
      const world = uniform(source.object.matrixWorld);
      this.kernel = (
        Fn(() => {
          const p = local.element(instanceIndex).xyz;
          out.element(instanceIndex.mul(2)).assign(vec4((world as N).mul(vec4(p, 1)).xyz, 1));
          const nw = normalize((world as N).mul(vec4(localN.element(instanceIndex).xyz, 0)).xyz);
          out.element(instanceIndex.mul(2).add(1)).assign(vec4(nw, 0));
        }) as N
      )()
        .compute(n, [64])
        .setName('hair.deform.rigid');
    } else {
      const mesh = source.mesh;
      const skinIndex = instancedArray(source.skinIndex, 'uvec4').toReadOnly() as N;
      const skinWeight = instancedArray(source.skinWeight, 'vec4').toReadOnly() as N;
      this.buffers.push(skinIndex, skinWeight);
      const bones = buffer(mesh.skeleton.boneMatrices, 'mat4', mesh.skeleton.bones.length) as N;
      const bindMatrix = uniform(mesh.bindMatrix) as N;
      const bindMatrixInverse = uniform(mesh.bindMatrixInverse) as N;
      const meshWorld = uniform(mesh.matrixWorld) as N;
      this.kernel = (
        Fn(() => {
          const i = instanceIndex;
          const p = local.element(i).xyz;
          const si = skinIndex.element(i);
          const sw = skinWeight.element(i);
          const skinMat = bones
            .element(si.x)
            .mul(sw.x)
            .add(bones.element(si.y).mul(sw.y))
            .add(bones.element(si.z).mul(sw.z))
            .add(bones.element(si.w).mul(sw.w))
            .toVar();
          const full = meshWorld.mul(bindMatrixInverse).mul(skinMat).mul(bindMatrix).toVar();
          out.element(i.mul(2)).assign(vec4(full.mul(vec4(p, 1)).xyz, 1));
          out
            .element(i.mul(2).add(1))
            .assign(vec4(normalize(full.mul(vec4(localN.element(i).xyz, 0)).xyz), 0));
        }) as N
      )()
        .compute(n, [64])
        .setName('hair.deform.skinned');
    }
  }

  dispose(release: (buffers: N[]) => void): void {
    this.kernel.dispose();
    release(this.buffers);
  }

  /** Brings CPU-side matrices up to date before the compute dispatch. */
  prepare(): void {
    if (this.source.kind === 'rigid') {
      this.source.object.updateWorldMatrix(true, false);
    } else {
      const mesh = this.source.mesh;
      mesh.updateWorldMatrix(true, true);
      mesh.skeleton.update();
    }
  }
}

/**
 * Computes bind-pose world positions on the CPU (matches the GPU deform at bind time) —
 * used as the groom's growth mesh.
 */
export function bindPoseWorldPositions(source: DeformSource): Float32Array {
  const n = source.localPositions.length / 3;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  if (source.kind === 'rigid') {
    source.object.updateWorldMatrix(true, false);
    for (let i = 0; i < n; i++) {
      v.fromArray(source.localPositions, i * 3).applyMatrix4(source.object.matrixWorld);
      v.toArray(out, i * 3);
    }
  } else {
    const mesh = source.mesh;
    mesh.updateWorldMatrix(true, true);
    mesh.skeleton.update();
    const sv = new THREE.Vector4();
    const acc = new THREE.Vector4();
    const tmp = new THREE.Vector4();
    const bm = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      sv.set(
        source.localPositions[i * 3],
        source.localPositions[i * 3 + 1],
        source.localPositions[i * 3 + 2],
        1,
      ).applyMatrix4(mesh.bindMatrix);
      acc.set(0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = source.skinWeight[i * 4 + k];
        if (w === 0) continue;
        bm.fromArray(mesh.skeleton.boneMatrices!, source.skinIndex[i * 4 + k] * 16);
        tmp.copy(sv).applyMatrix4(bm).multiplyScalar(w);
        acc.add(tmp);
      }
      acc.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
      out[i * 3] = acc.x;
      out[i * 3 + 1] = acc.y;
      out[i * 3 + 2] = acc.z;
    }
  }
  return out;
}
