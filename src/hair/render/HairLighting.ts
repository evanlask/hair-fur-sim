import * as THREE from 'three/webgpu';

import type { LightRig } from '../../app/LightRig';
import { tsl } from '../sim/tsl';
import type { N } from '../sim/tslUtil';
import { equirectToIrradianceSH } from './envSH';

const { luminance, max, mix, uniform, uniformArray, vec3 } = tsl;

export interface HairLight {
  /** Unit direction towards the light (world). */
  dir: N;
  /** Linear color × intensity. */
  color: N;
}

/**
 * Lighting inputs for the hair shade kernel, mirrored each frame from the scene's light rig.
 * Hair is lit in a compute pass (once per strand point), so it reads these uniforms instead of
 * three.js's per-fragment light loop. Environment light comes from 9-coefficient SH.
 */
export class HairLighting {
  readonly key: HairLight = {
    dir: uniform(new THREE.Vector3(0, 1, 0)),
    color: uniform(new THREE.Color(1, 1, 1)),
  };
  readonly rim: HairLight = {
    dir: uniform(new THREE.Vector3(0, 1, 0)),
    color: uniform(new THREE.Color(0, 0, 0)),
  };
  readonly fill: HairLight = {
    dir: uniform(new THREE.Vector3(0, 1, 0)),
    color: uniform(new THREE.Color(0, 0, 0)),
  };
  readonly cameraPos = uniform(new THREE.Vector3());
  readonly envIntensity = uniform(1);
  /** Environment colour saturation for hair (tames strongly tinted maps). */
  readonly envSaturation = uniform(1);
  // vec4 (w unused) because vec3 uniform array elements are padded to 16 bytes anyway.
  private readonly shData = Array.from({ length: 9 }, () => new THREE.Vector4());
  readonly sh = uniformArray(this.shData, 'vec4');

  constructor(envTexture: THREE.Texture | null) {
    this.setEnvironment(envTexture);
  }

  setEnvironment(texture: THREE.Texture | null): void {
    for (const v of this.shData) v.set(0, 0, 0, 0);
    if (!texture || !(texture.image as { data?: unknown })?.data) {
      // No CPU-readable HDR: flat grey ambient (DC term only, ÷ Y00 so it evaluates to this color).
      this.shData[0].set(0.25, 0.25, 0.27, 0).multiplyScalar(1 / 0.282095);
      return;
    }
    const sh = equirectToIrradianceSH(texture);
    sh.forEach((c, i) => this.shData[i].set(c.x, c.y, c.z, 0));
  }

  /** Cosine-convolved environment radiance around direction n (world). */
  envDiffuse(n: N): N {
    const c = this.sh as N;
    const x = n.x;
    const y = n.y;
    const z = n.z;
    const r = c
      .element(0)
      .xyz.mul(0.282095)
      .add(c.element(1).xyz.mul(y.mul(0.488603)))
      .add(c.element(2).xyz.mul(z.mul(0.488603)))
      .add(c.element(3).xyz.mul(x.mul(0.488603)))
      .add(c.element(4).xyz.mul(x.mul(y).mul(1.092548)))
      .add(c.element(5).xyz.mul(y.mul(z).mul(1.092548)))
      .add(c.element(6).xyz.mul(z.mul(z).mul(3).sub(1).mul(0.315392)))
      .add(c.element(7).xyz.mul(x.mul(z).mul(1.092548)))
      .add(c.element(8).xyz.mul(x.mul(x).sub(y.mul(y)).mul(0.546274)));
    const radiance = max(r, vec3(0));
    return mix(vec3(luminance(radiance)), radiance, this.envSaturation).mul(this.envIntensity);
  }

  sync(rig: LightRig, camera: THREE.Camera, scene: THREE.Scene): void {
    const set = (l: HairLight, light: THREE.DirectionalLight) => {
      (l.dir.value as THREE.Vector3).copy(light.position).sub(light.target.position).normalize();
      (l.color.value as THREE.Color).copy(light.color).multiplyScalar(light.visible ? light.intensity : 0);
    };
    set(this.key, rig.key);
    set(this.rim, rig.rim);
    set(this.fill, rig.fill);
    camera.getWorldPosition(this.cameraPos.value as THREE.Vector3);
    this.envIntensity.value = scene.environmentIntensity;
    this.envSaturation.value = rig.params.envSaturation;
  }
}
