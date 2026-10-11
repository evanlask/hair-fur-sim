import type { FieldName, PaintedFields } from '../../hair/groom/styles/paintedStyle';

const width = (c: FieldName) => (c === 'flow' ? 3 : 1);

/** A stroke's changes to one layer's maps: just the vertices it touched, with their values before and after. */
export interface PaintChange {
  kind: 'paint';
  label: string;
  layerId: string;
  channels: FieldName[];
  indices: Uint32Array;
  /** Per channel, the touched vertices' values (3 per vertex for the flow). */
  before: Float32Array[];
  after: Float32Array[];
}

/** Any other edit (layer operations, fills, presets), as a pair of functions. */
export interface ActionChange {
  kind: 'action';
  label: string;
  undo(): void;
  redo(): void;
}

export type Change = PaintChange | ActionChange;

/** Writes a paint change's values into a layer's maps. */
export function writeValues(fields: PaintedFields, c: PaintChange, values: Float32Array[]): void {
  c.channels.forEach((ch, k) => {
    const f = fields[ch];
    const w = width(ch);
    const v = values[k];
    for (let j = 0; j < c.indices.length; j++)
      for (let e = 0; e < w; e++) f[c.indices[j] * w + e] = v[j * w + e];
  });
}

/**
 * A whole-map edit as an undoable change: `before` holds full copies of the channels from before it, and only the
 * vertices whose values differ now are kept. Null if nothing changed.
 */
export function diffChange(
  fields: PaintedFields,
  layerId: string,
  label: string,
  channels: FieldName[],
  before: Float32Array[],
): PaintChange | null {
  const changed: number[] = [];
  const n = fields.density.length;
  for (let i = 0; i < n; i++)
    if (
      channels.some((ch, k) => {
        const w = width(ch);
        for (let e = 0; e < w; e++) if (fields[ch][i * w + e] !== before[k][i * w + e]) return true;
        return false;
      })
    )
      changed.push(i);
  if (changed.length === 0) return null;
  const indices = Uint32Array.from(changed);
  const pick = (src: Float32Array, ch: FieldName) => {
    const w = width(ch);
    const out = new Float32Array(indices.length * w);
    for (let j = 0; j < indices.length; j++)
      for (let e = 0; e < w; e++) out[j * w + e] = src[indices[j] * w + e];
    return out;
  };
  return {
    kind: 'paint',
    label,
    layerId,
    channels,
    indices,
    before: channels.map((ch, k) => pick(before[k], ch)),
    after: channels.map((ch) => pick(fields[ch], ch)),
  };
}

/** Collects the values a stroke overwrites, the first time it touches each vertex. */
export class StrokeRecorder {
  private readonly slots = new Map<number, number>();
  private readonly before: number[][];
  private readonly fields: PaintedFields;
  private readonly channels: FieldName[];

  constructor(fields: PaintedFields, channels: FieldName[]) {
    this.fields = fields;
    this.channels = channels;
    this.before = channels.map(() => []);
  }

  /** Call before changing vertex `i` (see brushes' BeforeChange). */
  readonly touch = (i: number): void => {
    if (this.slots.has(i)) return;
    this.slots.set(i, this.slots.size);
    this.channels.forEach((ch, k) => {
      const w = width(ch);
      for (let e = 0; e < w; e++) this.before[k].push(this.fields[ch][i * w + e]);
    });
  };

  /** Vertex `i`'s value in `channel` (`e`: flow component) from before the stroke (see brushes' StartValue). */
  readonly startValue = (channel: FieldName, i: number, e = 0): number => {
    const w = width(channel);
    const slot = this.slots.get(i);
    const k = this.channels.indexOf(channel);
    return slot === undefined || k < 0 ? this.fields[channel][i * w + e] : this.before[k][slot * w + e];
  };

  get touched(): number {
    return this.slots.size;
  }

  /** The stroke as an undoable change, or null if it touched nothing. */
  finish(layerId: string, label: string): PaintChange | null {
    if (this.slots.size === 0) return null;
    const indices = Uint32Array.from(this.slots.keys());
    const after = this.channels.map((ch) => {
      const w = width(ch);
      const out = new Float32Array(indices.length * w);
      for (let j = 0; j < indices.length; j++)
        for (let e = 0; e < w; e++) out[j * w + e] = this.fields[ch][indices[j] * w + e];
      return out;
    });
    return {
      kind: 'paint',
      label,
      layerId,
      channels: this.channels,
      indices,
      before: this.before.map((b) => Float32Array.from(b)),
      after,
    };
  }
}

/** Undo / redo stacks. Paint changes are applied through `applyPaint` (the owner knows the layers). */
export class History {
  /** Most recent changes kept. */
  static readonly LIMIT = 100;
  private readonly done: Change[] = [];
  private readonly undone: Change[] = [];
  onChange: (() => void) | null = null;
  private readonly applyPaint: (c: PaintChange, values: Float32Array[]) => void;

  constructor(applyPaint: (c: PaintChange, values: Float32Array[]) => void) {
    this.applyPaint = applyPaint;
  }

  push(c: Change): void {
    this.done.push(c);
    if (this.done.length > History.LIMIT) this.done.shift();
    this.undone.length = 0;
    this.onChange?.();
  }

  undo(): Change | null {
    const c = this.done.pop();
    if (!c) return null;
    if (c.kind === 'paint') this.applyPaint(c, c.before);
    else c.undo();
    this.undone.push(c);
    this.onChange?.();
    return c;
  }

  redo(): Change | null {
    const c = this.undone.pop();
    if (!c) return null;
    if (c.kind === 'paint') this.applyPaint(c, c.after);
    else c.redo();
    this.done.push(c);
    this.onChange?.();
    return c;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** What undo / redo would change next (for their buttons' tooltips). */
  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.onChange?.();
  }
}
