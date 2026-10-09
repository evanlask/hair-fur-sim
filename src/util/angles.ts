import * as THREE from 'three/webgpu';

/** Unit vector for an azimuth (degrees around +Y, 0 = +Z, 90 = +X) and elevation (degrees above the horizon). */
export function dirFromAngles(azDeg: number, elDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
