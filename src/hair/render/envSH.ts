import * as THREE from 'three/webgpu';

/**
 * Projects an equirectangular HDR environment onto 2nd-order spherical harmonics (9 RGB coeffs).
 * Returns coefficients already convolved for irradiance (Ramamoorthi & Hanrahan) and divided by
 * π, so HairLighting.envDiffuse(n) gives irradiance / π (cosine-convolved radiance).
 */
export function equirectToIrradianceSH(texture: THREE.Texture): THREE.Vector3[] {
  const image = texture.image as { data: ArrayLike<number>; width: number; height: number };
  const { width: W, height: H, data } = image;
  const isHalf = data instanceof Uint16Array;
  const channels = data.length / (W * H);
  const read = (i: number) => (isHalf ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  const sh = Array.from({ length: 9 }, () => new THREE.Vector3());
  const step = Math.max(1, Math.floor(W / 256)); // subsample big maps
  let weightSum = 0;
  const c = new THREE.Vector3();
  for (let y = 0; y < H; y += step) {
    const theta = ((y + 0.5) / H) * Math.PI; // 0 at top
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let x = 0; x < W; x += step) {
      const phi = ((x + 0.5) / W) * Math.PI * 2;
      // three.js equirect convention: u = atan(dir.z, dir.x) / 2π + 0.5, v = asin(dir.y)/π + 0.5
      const dx = -Math.cos(phi) * sinT;
      const dy = cosT;
      const dz = -Math.sin(phi) * sinT;
      const i = (y * W + x) * channels;
      c.set(read(i), read(i + 1), read(i + 2));
      const w = sinT; // solid angle ∝ sin θ
      weightSum += w;
      const basis = shBasis(dx, dy, dz);
      for (let k = 0; k < 9; k++) sh[k].addScaledVector(c, basis[k] * w);
    }
  }
  const norm = (4 * Math.PI) / weightSum;
  // Cosine-lobe convolution factors per band, divided by π.
  const A = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];
  for (let k = 0; k < 9; k++) sh[k].multiplyScalar(norm * A[k]);
  return sh;
}

/** Real SH basis (l ≤ 2) evaluated at a unit direction. Must match HairLighting.envDiffuse. */
export function shBasis(x: number, y: number, z: number): number[] {
  return [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}
