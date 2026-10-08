import * as THREE from 'three/webgpu';

import type { ColliderSet } from '../colliders';

/** Wireframe capsules mirroring a ColliderSet (debug view). */
export class ColliderDebug {
  readonly group = new THREE.Group();
  private readonly meshes: { mesh: THREE.Mesh; r: number; len: number }[] = [];
  private readonly material = new THREE.MeshBasicNodeMaterial({
    color: 0x66e0ff,
    wireframe: true,
    transparent: true,
    opacity: 0.35,
  });
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private readonly colliders: ColliderSet;

  constructor(colliders: ColliderSet) {
    this.colliders = colliders;
    this.group.name = 'collider-debug';
    this.group.visible = false;
    for (let i = 0; i < colliders.capsules.length; i++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      mesh.frustumCulled = false;
      this.meshes.push({ mesh, r: -1, len: -1 });
      this.group.add(mesh);
    }
  }

  update(): void {
    if (!this.group.visible) return;
    for (let i = 0; i < this.meshes.length; i++) {
      const entry = this.meshes[i];
      const r = this.colliders.worldCapsule(i, this.a, this.b);
      const len = this.a.distanceTo(this.b);
      // Endpoints move rigidly with their attachment, so the capsule is only rebuilt when its radius or length
      // changes (radius scale, scaled attachment).
      if (Math.abs(entry.r - r) > 1e-4 || Math.abs(entry.len - len) > 1e-4) {
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = new THREE.CapsuleGeometry(r, Math.max(len, 1e-4), 4, 12);
        entry.r = r;
        entry.len = len;
      }
      entry.mesh.position.copy(this.a).add(this.b).multiplyScalar(0.5);
      this.dir.copy(this.b).sub(this.a);
      if (this.dir.lengthSq() > 1e-12)
        entry.mesh.quaternion.setFromUnitVectors(this.up, this.dir.normalize());
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.mesh.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
