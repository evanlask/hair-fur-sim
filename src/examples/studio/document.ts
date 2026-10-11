import type { HairParamsData } from '../../hair/params';
import { mergeHairParams } from '../../hair/params';
import { MAP_LENGTH_MAX } from './brushes';
import type { HeadModel } from './heads';
import { emptyLayer, type Layer, type LayerSettings } from './layers';
import type { PaintMesh } from './paintMesh';

/** What a document is read from / written to: the head and its paint vertices (the StudioBust). */
export interface PaintTarget {
  head: Pick<HeadModel, 'id' | 'frame'>;
  paint: PaintMesh;
}

/** Bump when the encoding changes (older documents are then rejected, or migrated here). */
export const DOCUMENT_VERSION = 1;
const APP = 'hair-fur-sim/groom-studio';

/** A saved groom: its layers and their painted maps, on one head. */
export interface GroomDocument {
  app: typeof APP;
  version: number;
  /** Head the maps are painted on (HeadModel.id). */
  head: string;
  /** Paint vertices of that head: maps only load onto the same mesh. */
  vertices: number;
  layers: LayerDocument[];
}

export interface LayerDocument {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  uiColor: string;
  settings: LayerSettings;
  params: HairParamsData;
  /** The painted vertices (density > 0) and their maps, packed (see packMaps) and base64-encoded. */
  maps: string;
}

/** Quantization of the length (u16 range), curve and wave (u8 steps) maps. */
const LENGTH_MAX = MAP_LENGTH_MAX;
const CURVE_STEP = 0.25;
const WAVE_STEP = 0.0001;

export function encodeDocument(bust: PaintTarget, layers: Layer[]): GroomDocument {
  return {
    app: APP,
    version: DOCUMENT_VERSION,
    head: bust.head.id,
    vertices: bust.paint.count,
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      uiColor: l.uiColor,
      settings: { ...l.settings },
      params: structuredClone(l.params),
      maps: toBase64(packMaps(l, bust.paint)),
    })),
  };
}

/** Why a document can't be loaded onto this bust as it is, or null if it can. */
export function documentProblem(doc: unknown, bust: PaintTarget): string | null {
  const d = doc as Partial<GroomDocument> | null;
  if (!d || d.app !== APP || !Array.isArray(d.layers)) return 'not a Groom Studio file';
  if (d.version !== DOCUMENT_VERSION) return `made by another version of the studio (v${d.version})`;
  if (d.head !== bust.head.id || d.vertices !== bust.paint.count) return OTHER_HEAD;
  return null;
}

/** documentProblem's answer for a groom painted on another mesh (another head, or an older version of this one). */
export const OTHER_HEAD = 'made on another head or mesh';

/** Layers of a document made on this bust (see documentProblem). */
export function decodeDocument(doc: GroomDocument, bust: PaintTarget, substeps: number): Layer[] {
  return doc.layers.map((d) => {
    // Unpainted vertices hold a new layer's defaults.
    const layer = emptyLayer(bust, substeps, d.settings.seed);
    const params = mergeHairParams(d.params);
    params.physics.substeps = substeps;
    Object.assign(layer, {
      id: d.id,
      name: d.name,
      visible: d.visible,
      locked: d.locked,
      uiColor: d.uiColor,
      settings: { ...layer.settings, ...d.settings },
      params,
    });
    unpackMaps(fromBase64(d.maps), layer);
    return layer;
  });
}

/**
 * Packs a layer's painted vertices and their neighbours (roots in a triangle at the edge of the painting blend all
 * three corners, so those load exactly too): their count, delta-coded indices (LEB128), then per vertex density,
 * lift and gravity (u8, 0..1), length (u16 over 0..2 m), curve (u8 in ¼ 1/m), wave (u8 in 0.1 mm) and flow (2 × u8,
 * octahedral).
 */
export function packMaps(layer: Layer, mesh: Pick<PaintMesh, 'neighborStart' | 'neighbors'>): Uint8Array {
  const f = layer.fields;
  const keep = new Uint8Array(f.density.length);
  for (let i = 0; i < f.density.length; i++) {
    if (f.density[i] <= 0.5 / 255) continue;
    keep[i] = 1;
    for (let j = mesh.neighborStart[i]; j < mesh.neighborStart[i + 1]; j++) keep[mesh.neighbors[j]] = 1;
  }
  const painted: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) painted.push(i);
  const bytes: number[] = [];
  const varint = (x: number) => {
    do {
      const b = x & 127;
      x = Math.floor(x / 128);
      bytes.push(x > 0 ? b | 128 : b);
    } while (x > 0);
  };
  varint(painted.length);
  let last = 0;
  for (const i of painted) {
    varint(i - last);
    last = i;
  }
  const u8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (const i of painted) {
    const len = Math.round((Math.min(LENGTH_MAX, Math.max(0, f.length[i])) / LENGTH_MAX) * 65535);
    const [ou, ov] = octEncode(f.flow[i * 3], f.flow[i * 3 + 1], f.flow[i * 3 + 2]);
    bytes.push(
      u8(f.density[i]),
      u8(f.lift[i]),
      u8(f.gravity[i]),
      len & 255,
      len >> 8,
      Math.min(255, Math.round(f.curve[i] / CURVE_STEP)),
      Math.min(255, Math.round(f.wave[i] / WAVE_STEP)),
      Math.round((ou * 0.5 + 0.5) * 255),
      Math.round((ov * 0.5 + 0.5) * 255),
    );
  }
  return Uint8Array.from(bytes);
}

/** Writes packed maps (see packMaps) into a layer's fields. */
export function unpackMaps(bytes: Uint8Array, layer: Layer): void {
  const f = layer.fields;
  let o = 0;
  const varint = () => {
    let x = 0;
    let scale = 1;
    let b: number;
    do {
      b = bytes[o++];
      x += (b & 127) * scale;
      scale *= 128;
    } while (b & 128);
    return x;
  };
  const n = varint();
  const index = new Uint32Array(n);
  let last = 0;
  for (let k = 0; k < n; k++) index[k] = last += varint();
  const flow = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const i = index[k];
    if (i >= f.density.length) break;
    f.density[i] = bytes[o] / 255;
    f.lift[i] = bytes[o + 1] / 255;
    f.gravity[i] = bytes[o + 2] / 255;
    f.length[i] = ((bytes[o + 3] | (bytes[o + 4] << 8)) / 65535) * LENGTH_MAX;
    f.curve[i] = bytes[o + 5] * CURVE_STEP;
    f.wave[i] = bytes[o + 6] * WAVE_STEP;
    octDecode((bytes[o + 7] / 255) * 2 - 1, (bytes[o + 8] / 255) * 2 - 1, flow);
    f.flow.set(flow, i * 3);
    o += 9;
  }
}

const sign = (x: number) => (x < 0 ? -1 : 1);

/** Unit vector → a point in [−1, 1]² (octahedral mapping, about 0.5° precision at 8 bits). */
export function octEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * sign(ou);
    v = (1 - Math.abs(ou)) * sign(v);
  }
  return [u, v];
}

export function octDecode(u: number, v: number, out: number[]): number[] {
  let x = u;
  let y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    x = (1 - Math.abs(v)) * sign(u);
    y = (1 - Math.abs(u)) * sign(v);
  }
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** localStorage key of a head's autosaved groom. */
export const storageKey = (head: string) => `fursim:studio:v${DOCUMENT_VERSION}:${head}`;
