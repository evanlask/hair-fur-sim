import * as THREE from 'three/webgpu';

import type { PaintedFields } from '../../hair/groom/styles/paintedStyle';
import type { PaintTool } from './brushes';
import type { Layer } from './layers';
import type { StudioBust } from './StudioBust';

/** The map an overlay shows, and the value range its colour ramp spans. */
const RAMPS: Record<'length' | 'lift' | 'curve' | 'wave', { field: keyof PaintedFields; max: number }> = {
  length: { field: 'length', max: 0.4 },
  lift: { field: 'lift', max: 1 },
  curve: { field: 'curve', max: 30 },
  wave: { field: 'wave', max: 0.015 },
};

/** A turbo-like ramp: dark blue → cyan → green → yellow → red, bright enough to read on skin. */
const STOPS = ['#30123b', '#4686fb', '#1ae4b6', '#a2fc3c', '#fabb39', '#e4460a'].map((c) =>
  new THREE.Color(c).convertLinearToSRGB(),
);

/** The ramp a tool's overlay shows (noise roughens the length most visibly, so it shows that). */
function rampOf(tool: PaintTool | 'navigate'): keyof typeof RAMPS | null {
  if (tool === 'noise') return 'length';
  return tool === 'length' || tool === 'lift' || tool === 'curve' || tool === 'wave' ? tool : null;
}

/** The overlay's colour ramp for a tool as a CSS gradient, with the values at its ends (for the panel's legend). */
export function rampLegend(t: PaintTool | 'navigate'): { css: string; from: string; to: string } | null {
  const tool = rampOf(t);
  if (!tool) return null;
  const { max } = RAMPS[tool];
  // (getHexString sRGB-encodes the already encoded stops, so the legend is lighter than their hex values.)
  const css = `linear-gradient(90deg, ${STOPS.map((c) => `#${c.getHexString()}`).join(', ')})`;
  const to = { length: `${max * 100} cm`, lift: '100%', curve: `${max} /m`, wave: `${max * 1000} mm` }[tool];
  return { css, from: '0', to };
}
function ramp(t: number, out: THREE.Color): THREE.Color {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  return out.copy(STOPS[i]).lerp(STOPS[i + 1], x - i);
}

const tmpColor = new THREE.Color();

/**
 * Colours the skin with the active layer's map for a tool: density in the layer's colour, the shape maps as a ramp
 * where the layer grows hair. Comb, part and navigate show none (comb and part show the guides instead).
 */
export function updateOverlay(bust: StudioBust, layer: Layer | null, tool: PaintTool | 'navigate'): void {
  const out = bust.overlay.array as Uint8Array;
  const weld = bust.paint.weld;
  const show = layer && tool !== 'navigate' && tool !== 'comb' && tool !== 'part' ? tool : null;
  if (!layer || !show) {
    out.fill(0);
    bust.overlay.needsUpdate = true;
    return;
  }
  const f = layer.fields;
  const swatch = new THREE.Color(layer.uiColor);
  const shown = rampOf(show);
  const key = shown ? RAMPS[shown] : null;
  // The length map holds lengths before the layer's length ×: show the lengths the hair grows.
  const scale = key?.field === 'length' ? layer.settings.lengthScale : 1;
  // Linear colours: the overlay is mixed into the skin's albedo.
  for (let v = 0; v < weld.length; v++) {
    const i = weld[v];
    const d = f.density[i];
    let a: number;
    if (key) {
      ramp(((f[key.field] as Float32Array)[i] * scale) / key.max, tmpColor).convertSRGBToLinear();
      a = Math.min(1, d * 1.5) * 0.85;
    } else {
      tmpColor.copy(swatch);
      a = d * 0.8;
    }
    out[v * 4] = tmpColor.r * 255;
    out[v * 4 + 1] = tmpColor.g * 255;
    out[v * 4 + 2] = tmpColor.b * 255;
    out[v * 4 + 3] = a * 255;
  }
  bust.overlay.needsUpdate = true;
}

/** updateScalpTint's buffers, reused between calls. */
let tintScratch: { n: number; amount: Float32Array; weight: Float32Array; rgb: Float32Array } | null = null;

/**
 * The skin under the hair: how much the visible layers cover it (their density; short hair hides less, so a fade
 * shows the skin through it), tinted by the layers' root colours.
 */
export function updateScalpTint(bust: StudioBust, layers: Layer[], solo: string | null): void {
  const n = bust.paint.count;
  if (tintScratch?.n !== n)
    tintScratch = {
      n,
      amount: new Float32Array(n),
      weight: new Float32Array(n),
      rgb: new Float32Array(n * 3),
    };
  const { amount, weight, rgb } = tintScratch;
  amount.fill(0);
  weight.fill(0);
  rgb.fill(0);
  for (const l of layers) {
    if (solo ? l.id !== solo : !l.visible) continue;
    const c = tmpColor.set(l.params.shading.rootColor);
    const { density: d, length } = l.fields;
    const bare = bust.bare;
    for (let i = 0; i < n; i++) {
      if (d[i] <= 0) continue;
      const t = Math.min(1, Math.max(0, (length[i] * l.settings.lengthScale - 0.002) / 0.018));
      // (No hair grows on the bare places, so no tint there either.)
      const cover = d[i] * (bare ? 1 - bare[i] : 1) * (0.7 + 0.3 * t * t * (3 - 2 * t));
      amount[i] = Math.max(amount[i], cover);
      weight[i] += cover;
      rgb[i * 3] += c.r * cover;
      rgb[i * 3 + 1] += c.g * cover;
      rgb[i * 3 + 2] += c.b * cover;
    }
  }
  const out = bust.scalpTint.array as Uint8Array;
  const weld = bust.paint.weld;
  for (let v = 0; v < weld.length; v++) {
    const i = weld[v];
    // Density-weighted mean of the layers' root colours (linear).
    const k = weight[i] > 0 ? 255 / weight[i] : 0;
    out[v * 4] = Math.min(255, rgb[i * 3] * k);
    out[v * 4 + 1] = Math.min(255, rgb[i * 3 + 1] * k);
    out[v * 4 + 2] = Math.min(255, rgb[i * 3 + 2] * k);
    out[v * 4 + 3] = Math.min(1, amount[i]) * 255;
  }
  bust.scalpTint.needsUpdate = true;
}

/** Ring cursors on the surface: the brush, and its mirror image. */
export class BrushCursor {
  readonly group = new THREE.Group();
  private readonly rings: THREE.Mesh[];
  private readonly material = new THREE.MeshBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  });
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  constructor() {
    const geometry = new THREE.RingGeometry(0.93, 1, 64);
    this.rings = [0, 1].map(() => {
      const m = new THREE.Mesh(geometry, this.material);
      m.renderOrder = 10;
      m.frustumCulled = false;
      m.visible = false;
      this.group.add(m);
      return m;
    });
    this.group.name = 'brush-cursor';
  }

  setColor(color: string): void {
    this.material.color.set(color);
  }

  /** Shows ring `i` at a world point, facing the world normal, `radius` meters wide. */
  show(i: number, point: THREE.Vector3, normal: THREE.Vector3, radius: number): void {
    const ring = this.rings[i];
    ring.visible = true;
    ring.position.copy(point).addScaledVector(normal, 0.0015);
    ring.quaternion.setFromUnitVectors(BrushCursor.Z, normal);
    ring.scale.setScalar(radius);
  }

  hide(i?: number): void {
    for (const [k, r] of this.rings.entries()) if (i === undefined || i === k) r.visible = false;
  }

  dispose(): void {
    this.rings[0].geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
