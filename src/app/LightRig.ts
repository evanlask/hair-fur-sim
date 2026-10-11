import * as THREE from 'three/webgpu';

import { dirFromAngles } from '../util/angles';

export interface LightParams {
  keyAzimuth: number;
  keyElevation: number;
  keyIntensity: number;
  keyColor: string;
  rimAzimuth: number;
  rimElevation: number;
  rimIntensity: number;
  rimColor: string;
  fillAzimuth: number;
  fillElevation: number;
  fillIntensity: number;
  fillColor: string;
  envIntensity: number;
  /** Saturation of the environment light on hair (1 = as captured). */
  envSaturation: number;
  exposure: number;
  shadowMapSize: number;
}

export const defaultLightParams = (): LightParams => ({
  keyAzimuth: 35,
  keyElevation: 45,
  keyIntensity: 3.2,
  keyColor: '#fff3e6',
  rimAzimuth: -160,
  rimElevation: 30,
  rimIntensity: 2.6,
  rimColor: '#cfe2ff',
  fillAzimuth: -70,
  fillElevation: 15,
  fillIntensity: 0.5,
  fillColor: '#ffe9d6',
  envIntensity: 0.6,
  envSaturation: 0.4,
  exposure: 1.0,
  shadowMapSize: 2048,
});

/** Studio three-point rig. The key light casts (opaque) shadows; rim light sells hair translucency. */
export class LightRig {
  readonly key = new THREE.DirectionalLight();
  readonly rim = new THREE.DirectionalLight();
  readonly fill = new THREE.DirectionalLight();
  readonly params = defaultLightParams();
  /** Point the rig is aimed at; shadow frustum is fit around `focus` with `focusRadius`. */
  readonly focus = new THREE.Vector3(0, 0.8, 0);
  focusRadius = 1.5;

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGPURenderer;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer) {
    this.scene = scene;
    this.renderer = renderer;
    for (const l of [this.key, this.rim, this.fill]) {
      scene.add(l, l.target);
    }
    this.key.name = 'key';
    this.rim.name = 'rim';
    this.fill.name = 'fill';
    this.key.castShadow = true;
    this.key.shadow.normalBias = 0;
    this.key.shadow.radius = 2;
    this.apply();
  }

  apply(): void {
    const p = this.params;
    this.key.color.set(p.keyColor);
    this.key.intensity = p.keyIntensity;
    this.rim.color.set(p.rimColor);
    this.rim.intensity = p.rimIntensity;
    this.fill.color.set(p.fillColor);
    this.fill.intensity = p.fillIntensity;
    this.scene.environmentIntensity = p.envIntensity;
    this.renderer.toneMappingExposure = p.exposure;
    if (this.key.shadow.mapSize.x !== p.shadowMapSize) {
      this.key.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      // three.js allocates the shadow map once; clearing it makes the next render recreate it at the new size.
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null as unknown as THREE.RenderTarget;
    }
    this.update();
  }

  /** Re-aims lights at the focus and fits the key light's shadow frustum. */
  update(): void {
    const p = this.params;
    const d = new THREE.Vector3();
    const dist = this.focusRadius * 3 + 2;
    const place = (l: THREE.DirectionalLight, az: number, el: number) => {
      dirFromAngles(az, el, d);
      l.position.copy(this.focus).addScaledVector(d, dist);
      l.target.position.copy(this.focus);
      l.updateMatrixWorld();
      l.target.updateMatrixWorld();
    };
    place(this.key, p.keyAzimuth, p.keyElevation);
    place(this.rim, p.rimAzimuth, p.rimElevation);
    place(this.fill, p.fillAzimuth, p.fillElevation);
    const cam = this.key.shadow.camera as THREE.OrthographicCamera;
    const r = this.focusRadius;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = Math.max(0.01, dist - r * 2);
    // Reach far enough to cover the floor (y = 0) under the whole frustum, or shadows cast onto it
    // from above the focus fall past the far plane. Capped for grazing lights (floor radius is 12).
    const sinEl = Math.max(Math.sin(THREE.MathUtils.degToRad(p.keyElevation)), 0.05);
    const toFloor = Math.min((Math.max(this.focus.y, 0) + r) / sinEl, 12);
    cam.far = dist + Math.max(r * 2, toFloor);
    // Bias is in normalized depth; rescale so it stays the same world distance as the depth range grows.
    this.key.shadow.bias = (-0.0004 * (r * 4)) / (cam.far - cam.near);
    cam.updateProjectionMatrix();
  }
}
