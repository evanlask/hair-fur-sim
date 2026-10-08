import type * as THREE from 'three/webgpu';

/**
 * CPU sampler for a loaded texture (ImageBitmap / HTMLImageElement): returns linear RGB at uv, nearest-
 * neighbour. Respects `texture.flipY` (glTF textures are not flipped). `downsample` > 1 samples a smaller,
 * filtered copy bilinearly instead, i.e. a blurred lookup that keeps regional colour but drops fine detail.
 */
export function createTextureSampler(
  texture: THREE.Texture,
  downsample = 1,
): ((u: number, v: number) => [number, number, number]) | null {
  const img = texture.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width) return null;
  const w = Math.max(1, Math.round(img.width / downsample));
  const h = Math.max(1, Math.round(img.height / downsample));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  // sRGB → linear.
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const flip = texture.flipY;
  if (downsample <= 1) {
    return (u: number, v: number) => {
      const uu = u - Math.floor(u);
      const vv = v - Math.floor(v);
      const x = Math.min(w - 1, Math.floor(uu * w));
      const y = Math.min(h - 1, Math.floor((flip ? 1 - vv : vv) * h));
      const i = (y * w + x) * 4;
      return [lut[data[i]], lut[data[i + 1]], lut[data[i + 2]]];
    };
  }
  return (u: number, v: number) => {
    const uu = u - Math.floor(u);
    const vv = v - Math.floor(v);
    const fx = Math.min(w - 1, Math.max(0, uu * w - 0.5));
    const fy = Math.min(h - 1, Math.max(0, (flip ? 1 - vv : vv) * h - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = lut[data[(y0 * w + x0) * 4 + c]] * (1 - tx) + lut[data[(y0 * w + x1) * 4 + c]] * tx;
      const b = lut[data[(y1 * w + x0) * 4 + c]] * (1 - tx) + lut[data[(y1 * w + x1) * 4 + c]] * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  };
}
