import * as THREE from 'three/webgpu';

import type { App } from '../../app/App';
import { IS_MAC, modHeld } from '../../util/platform';
import {
  applyDab,
  changesDensity,
  defaultBrush,
  mirrorDirection,
  mirrorPoint,
  strokeChannels,
  type BrushSettings,
  type Dab,
  type PaintTool,
  type Tool,
} from './brushes';
import { StrokeRecorder, writeValues, type PaintChange } from './history';
import type { Layer } from './layers';
import { BrushCursor } from './overlay';
import type { StudioBust } from './StudioBust';

/** Where strokes go; implemented by the studio. */
export interface PaintTarget {
  /** The layer being painted, or null (nothing happens). */
  layer(): Layer | null;
  /**
   * This frame's dabs changed the layer's maps around `centers` (model space) within `radius` (model units);
   * `density`: they changed where hair grows (not just its shape).
   */
  painted(layer: Layer, tool: PaintTool, density: boolean, centers: THREE.Vector3[], radius: number): void;
  /** A stroke ended: its change (null if it touched nothing), or `cancelled` after its changes were put back. */
  strokeEnded(layer: Layer, density: boolean, change: PaintChange | null, cancelled: boolean): void;
  /** The eyedropper picked a value under the cursor into the brush. */
  picked(): void;
  /** A click on the head did nothing, and why (no layer, a locked layer). */
  notice(text: string): void;
}

interface Sample {
  x: number;
  y: number;
  pressure: number;
  invert: boolean;
}

interface Hit {
  /** Model space. */
  point: THREE.Vector3;
  normal: THREE.Vector3;
  world: THREE.Vector3;
  worldNormal: THREE.Vector3;
}

/** Raycasts per frame while stroking (each ~0.6 ms on the Lee scan); coalesced samples beyond it are skipped. */
const MAX_PICKS_PER_FRAME = 6;

/**
 * Pointer input → brush strokes on the bust. Left-drag on the head paints with the current tool (⌘ / Ctrl inverts,
 * Shift smooths, Alt orbits, Escape cancels), as in sculpting tools; elsewhere the camera works as usual. A stroke
 * dabs every quarter radius along its path, and again mirrored about the head's midline (except partings).
 */
export class PaintController {
  private current: Tool = 'navigate';
  readonly brush = defaultBrush();
  /** Each paint tool's brush radius and strength as last used (a tool not used yet starts with the current ones). */
  private readonly sizes = new Map<PaintTool, Pick<BrushSettings, 'radius' | 'strength'>>();
  readonly cursor = new BrushCursor();
  /** Hold to pick the value under the cursor into the brush instead of painting. */
  eyedropper = false;
  /** Paint vertex under the cursor (−1: off the head), for the value readout. */
  hoverVertex = -1;
  private stroke: {
    layer: Layer;
    tool: PaintTool;
    /** The brush as this stroke paints with it (Shift-smoothing sets its smooth mode). */
    brush: BrushSettings;
    recorder: StrokeRecorder;
    /** Its noise pattern. */
    seed: number;
    last: THREE.Vector3 | null;
    lastNormal: THREE.Vector3;
    dir: THREE.Vector3 | null;
    pointerId: number;
  } | null = null;
  private readonly samples: Sample[] = [];
  private pointer: { x: number; y: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly centers: THREE.Vector3[] = [];

  private readonly app: App;
  private readonly bust: StudioBust;
  private readonly target: PaintTarget;

  constructor(app: App, bust: StudioBust, target: PaintTarget) {
    this.app = app;
    this.bust = bust;
    this.target = target;
    app.scene.add(this.cursor.group);
    // Capture phase: a stroke that starts on the head never reaches the camera controls or the grab spring.
    app.container.addEventListener('pointerdown', this.onDown, { capture: true });
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  get painting(): boolean {
    return this.stroke !== null;
  }

  get tool(): Tool {
    return this.current;
  }

  /** Switches tool: each paint tool keeps its own brush size and strength. */
  set tool(tool: Tool) {
    const b = this.brush;
    if (this.current !== 'navigate') this.sizes.set(this.current, { radius: b.radius, strength: b.strength });
    this.current = tool;
    const size = tool === 'navigate' ? undefined : this.sizes.get(tool);
    if (size) Object.assign(b, size);
  }

  private onDown = (e: PointerEvent) => {
    // Ctrl-click on a Mac is a right-click (the context menu opens), so it doesn't paint.
    if (this.tool === 'navigate' || e.button !== 0 || e.altKey || (IS_MAC && e.ctrlKey)) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    const layer = this.target.layer();
    if (!layer) {
      this.target.notice('Add a layer first (+ Add layer), or apply a style');
      return;
    }
    if (this.eyedropper) {
      this.pickValue(layer, hit);
      return;
    }
    if (layer.locked) {
      this.target.notice(`“${layer.name}” is locked: unlock it in the layer list to paint`);
      return;
    }
    // Painting still works (the map shows on the skin), but the hair doesn't: say why.
    if (!layer.visible)
      this.target.notice(`“${layer.name}” is hidden: show it (eye in the layer list) to see its hair`);
    this.app.container.setPointerCapture(e.pointerId);
    this.startStroke(layer, hit, e.shiftKey, e.pointerId);
    this.samples.push(sampleOf(e));
  };

  /** Starts a stroke with the current tool, or (`smoothing`, Shift held) a Smooth stroke of what that tool paints. */
  private startStroke(layer: Layer, hit: Hit, smoothing: boolean, pointerId: number): void {
    const smoothInstead = smoothing && this.tool !== 'smooth' && this.tool !== 'navigate';
    const tool: PaintTool = smoothInstead ? 'smooth' : (this.tool as PaintTool);
    const brush: BrushSettings = smoothInstead
      ? { ...this.brush, smooth: this.tool === 'density' ? 'density' : 'shape' }
      : this.brush;
    this.stroke = {
      layer,
      tool,
      brush,
      recorder: new StrokeRecorder(layer.fields, strokeChannels(tool, brush.smooth)),
      seed: Math.floor(Math.random() * 2 ** 30),
      last: null,
      lastNormal: hit.normal.clone(),
      dir: null,
      pointerId,
    };
  }

  private onMove = (e: PointerEvent) => {
    // Over the panels there is no cursor (unless a stroke runs on underneath).
    this.pointer =
      e.target === this.app.renderer.domElement || this.stroke ? { x: e.clientX, y: e.clientY } : null;
    if (!this.stroke || e.pointerId !== this.stroke.pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const c of events.length ? events : [e]) this.samples.push(sampleOf(c));
  };

  private onUp = (e: PointerEvent) => {
    if (!this.stroke || e.pointerId !== this.stroke.pointerId) return;
    this.processSamples();
    this.endStroke(false);
  };

  private onBlur = () => {
    if (this.stroke) this.endStroke(false);
  };

  /**
   * Paints a stroke through model-space points with the current tool, as a drag over them would (for scripts and
   * automated checks: `__fursim.example.studio.stroke`).
   */
  strokeThrough(points: THREE.Vector3[], invert = false, smoothing = false): void {
    const layer = this.target.layer();
    if (!layer || this.tool === 'navigate' || layer.locked || points.length === 0) return;
    const paint = this.bust.paint;
    const hitAt = (p: THREE.Vector3): Hit => {
      const i = nearestPaintVertex(paint, p, 0.1 / this.bust.head.scale);
      const normal =
        i >= 0 ? new THREE.Vector3().fromArray(paint.normals, i * 3) : new THREE.Vector3(0, 1, 0);
      const m = this.bust.pickMesh.matrixWorld;
      return {
        point: p.clone(),
        normal,
        world: p.clone().applyMatrix4(m),
        worldNormal: normal.clone().transformDirection(m),
      };
    };
    this.startStroke(layer, hitAt(points[0]), smoothing, -1);
    const s = this.stroke!;
    this.centers.length = 0;
    const sample: Sample = { x: 0, y: 0, pressure: 1, invert };
    for (const p of points) this.dabTo(hitAt(p), sample);
    if (this.centers.length) this.reportPainted(s);
    this.endStroke(false);
  }

  private reportPainted(s: NonNullable<typeof this.stroke>): void {
    const density = changesDensity(s.tool, s.brush.smooth);
    this.target.painted(
      s.layer,
      s.tool,
      density,
      this.centers.slice(),
      this.brush.radius / this.bust.head.scale,
    );
  }

  /** Escape: ends the stroke and puts back everything it changed. */
  cancel(): void {
    if (this.stroke) this.endStroke(true);
  }

  private endStroke(cancel: boolean): void {
    const s = this.stroke!;
    this.stroke = null;
    this.samples.length = 0;
    if (s.pointerId >= 0 && this.app.container.hasPointerCapture(s.pointerId))
      this.app.container.releasePointerCapture(s.pointerId);
    const change = s.recorder.finish(s.layer.id, `paint ${TOOL_LABELS[s.tool]}`);
    if (cancel && change) writeValues(s.layer.fields, change, change.before);
    this.target.strokeEnded(s.layer, changesDensity(s.tool, s.brush.smooth), cancel ? null : change, cancel);
  }

  private pick(clientX: number, clientY: number): Hit | null {
    const r = this.app.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.app.camera);
    const hit = this.raycaster.intersectObject(this.bust.pickMesh, false)[0];
    if (!hit?.face) return null;
    const m = this.bust.pickMesh;
    return {
      point: m.worldToLocal(hit.point.clone()),
      normal: hit.face.normal.clone(),
      world: hit.point.clone(),
      worldNormal: hit.face.normal.clone().transformDirection(m.matrixWorld),
    };
  }

  /** Per frame: paints the pointer samples since the last frame and moves the cursor. */
  update(): void {
    if (this.stroke) this.processSamples();
    this.updateCursor();
  }

  private processSamples(): void {
    const s = this.stroke;
    if (!s || this.samples.length === 0) return;
    // Spread the picks over the samples (always including the latest).
    const n = this.samples.length;
    const step = Math.max(1, Math.ceil(n / MAX_PICKS_PER_FRAME));
    const picked: Sample[] = [];
    for (let i = n - 1; i >= 0; i -= step) picked.unshift(this.samples[i]);
    this.samples.length = 0;
    this.centers.length = 0;
    for (const sample of picked) {
      const hit = this.pick(sample.x, sample.y);
      if (hit) this.dabTo(hit, sample);
    }
    if (this.centers.length) this.reportPainted(s);
  }

  /** Dabs from the stroke's last dab towards `hit`, every quarter radius. */
  private dabTo(hit: Hit, sample: Sample): void {
    const s = this.stroke!;
    const radius = this.brush.radius / this.bust.head.scale;
    if (!s.last) {
      s.last = hit.point.clone();
      s.lastNormal.copy(hit.normal);
      this.dab(hit.point, hit.normal, null, sample);
      return;
    }
    const seg = hit.point.clone().sub(s.last);
    const len = seg.length();
    const spacing = Math.max(radius * 0.25, 1e-4);
    if (len < spacing) return;
    seg.divideScalar(len);
    s.dir = s.dir ? s.dir.lerp(seg, 0.5).normalize() : seg.clone();
    const steps = Math.floor(len / spacing);
    const c = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (let k = 1; k <= steps; k++) {
      const t = (k * spacing) / len;
      c.copy(s.last).addScaledVector(seg, k * spacing);
      nrm.copy(s.lastNormal).lerp(hit.normal, t).normalize();
      this.dab(c, nrm, s.dir, sample);
    }
    s.last.addScaledVector(seg, steps * spacing);
    s.lastNormal.copy(hit.normal);
  }

  private dab(center: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3 | null, sample: Sample): void {
    const s = this.stroke!;
    const fields = s.layer.fields;
    const paint = this.bust.paint;
    const d: Dab = {
      center,
      normal,
      direction: dir,
      radius: this.brush.radius / this.bust.head.scale,
      pressure: sample.pressure,
      invert: sample.invert,
      seed: s.seed,
    };
    const brush = s.tool === 'length' ? scaledLengthBrush(s.brush, s.layer.settings.lengthScale) : s.brush;
    applyDab(s.tool, fields, paint, d, brush, s.recorder.touch, s.recorder.startValue);
    this.centers.push(center.clone());
    // A parting is painted where it goes (a mirrored side part would make two).
    if (this.mirrors(s.tool)) {
      const midline = this.bust.head.frame.midlineX;
      const mc = mirrorPoint(center, midline, new THREE.Vector3());
      // Skip the reflection of dabs on the midline itself (they'd paint the same spot twice).
      if (Math.abs(mc.x - center.x) > d.radius * 0.5) {
        const mirrored: Dab = {
          ...d,
          center: mc,
          normal: mirrorDirection(normal, new THREE.Vector3()),
          direction: dir ? mirrorDirection(dir, new THREE.Vector3()) : null,
          mirrorX: midline,
        };
        applyDab(s.tool, fields, paint, mirrored, brush, s.recorder.touch, s.recorder.startValue);
        this.centers.push(mc);
      }
    }
  }

  private updateCursor(): void {
    const p = this.pointer;
    const hit = p && this.tool !== 'navigate' ? this.pick(p.x, p.y) : null;
    if (!hit) {
      this.cursor.hide();
      this.hoverVertex = -1;
      return;
    }
    const r = this.brush.radius;
    this.cursor.show(0, hit.world, hit.worldNormal, r);
    const paint = this.bust.paint;
    this.hoverVertex = nearestPaintVertex(paint, hit.point, r / this.bust.head.scale);
    if (this.mirrors(this.tool)) {
      const m = this.bust.pickMesh.matrixWorld;
      const mc = mirrorPoint(hit.point, this.bust.head.frame.midlineX, new THREE.Vector3()).applyMatrix4(m);
      const mn = mirrorDirection(hit.normal, new THREE.Vector3()).transformDirection(m);
      this.cursor.show(1, mc, mn, r);
    } else {
      this.cursor.hide(1);
    }
  }

  /** Whether strokes of a tool are mirrored onto the other side of the face. */
  private mirrors(tool: Tool): boolean {
    return this.brush.mirror && tool !== 'part';
  }

  /** Eyedropper: the active tool's value at the vertex under the cursor becomes the brush value. */
  private pickValue(layer: Layer, hit: Hit): void {
    const i = nearestPaintVertex(this.bust.paint, hit.point, this.brush.radius / this.bust.head.scale);
    if (i < 0) return;
    const f = layer.fields;
    const v = this.brush.value;
    switch (this.tool) {
      case 'density':
        v.density = f.density[i];
        break;
      case 'length':
        v.length = f.length[i] * layer.settings.lengthScale;
        break;
      case 'lift':
        v.lift = f.lift[i];
        break;
      case 'curve':
        v.curve = f.curve[i];
        this.brush.gravity = f.gravity[i];
        break;
      case 'wave':
        v.wave = f.wave[i];
        break;
      default:
        return;
    }
    this.target.picked();
  }

  dispose(): void {
    this.app.container.removeEventListener('pointerdown', this.onDown, { capture: true });
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.cursor.dispose();
  }
}

/** Tool names in undo labels ("paint length"). */
const TOOL_LABELS: Record<PaintTool, string> = {
  density: 'density',
  length: 'length',
  comb: 'comb',
  part: 'part',
  lift: 'lift',
  curve: 'bend',
  wave: 'wave',
  smooth: 'smooth',
  noise: 'noise',
};

function sampleOf(e: PointerEvent): Sample {
  // Mice report 0.5 while pressed; only pens and touch have real pressure.
  const pressure = e.pointerType === 'mouse' ? 1 : Math.max(0.1, e.pressure || 0.5);
  return { x: e.clientX, y: e.clientY, pressure, invert: modHeld(e) };
}

/** The paint vertex nearest a model-space point (within `reach`), or −1. */
function nearestPaintVertex(paint: StudioBust['paint'], p: THREE.Vector3, reach: number): number {
  let best = -1;
  let bestD2 = reach * reach;
  const ring = Math.max(1, Math.ceil(reach / paint.hash.cellSize));
  paint.hash.forEachNear(p.x, p.y, p.z, ring, (i, d2) => {
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  });
  return best;
}

/** The brush with its length target in the layer's map units (the map holds lengths before the layer's length ×). */
function scaledLengthBrush(brush: BrushSettings, lengthScale: number): BrushSettings {
  if (lengthScale === 1) return brush;
  return { ...brush, value: { ...brush.value, length: brush.value.length / Math.max(1e-6, lengthScale) } };
}
