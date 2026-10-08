import * as THREE from 'three/webgpu';

import type { App } from './App';

/**
 * Grab-and-drag interaction: pointer-drags an object on a camera-facing plane; the object
 * follows its target with a spring so hair reacts to the motion. Releasing returns it home.
 */
export class DragSpring {
  readonly target = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Rest position (may be animated by the example). */
  readonly home = new THREE.Vector3();
  dragging = false;
  stiffness = 120;
  damping = 14;
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane();
  private readonly offset = new THREE.Vector3();
  private readonly ndc = new THREE.Vector2();
  private readonly hit = new THREE.Vector3();

  private readonly app: App;
  private readonly object: THREE.Object3D;
  private readonly pick: () => THREE.Object3D[];

  constructor(app: App, object: THREE.Object3D, pick: () => THREE.Object3D[]) {
    this.app = app;
    this.object = object;
    this.pick = pick;
    this.home.copy(object.position);
    this.target.copy(object.position);
    const el = app.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  private setNdc(e: PointerEvent): void {
    const r = this.app.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.app.camera);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.setNdc(e);
    const hits = this.raycaster.intersectObjects(this.pick(), true);
    if (!hits.length) return;
    this.dragging = true;
    this.app.controls.enabled = false;
    const n = this.app.camera.getWorldDirection(new THREE.Vector3()).negate();
    this.plane.setFromNormalAndCoplanarPoint(n, hits[0].point);
    this.offset.copy(this.object.position).sub(hits[0].point);
    this.target.copy(this.object.position);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.setNdc(e);
    if (this.raycaster.ray.intersectPlane(this.plane, this.hit)) this.target.copy(this.hit).add(this.offset);
  };

  private onUp = () => {
    if (!this.dragging) return;
    this.dragging = false;
    this.app.controls.enabled = true;
  };

  update(dt: number): void {
    if (!this.dragging) this.target.copy(this.home);
    const pos = this.object.position;
    // Explicit Euler with this stiffness blows up at frame-sized steps, so substep at 240 Hz.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const acc = new THREE.Vector3();
    for (let i = 0; i < steps; i++) {
      acc
        .copy(this.target)
        .sub(pos)
        .multiplyScalar(this.stiffness)
        .addScaledVector(this.velocity, -this.damping);
      this.velocity.addScaledVector(acc, h);
      pos.addScaledVector(this.velocity, h);
    }
  }

  dispose(): void {
    this.app.renderer.domElement.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  }
}
