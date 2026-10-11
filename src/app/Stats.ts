import * as THREE from 'three/webgpu';

import type { HairStats } from '../hair/HairSystem';

export interface FrameStats {
  fps: number;
  cpuMs: number;
  /**
   * GPU time of a frame: from submission until the GPU finishes it. The quickest of the last second, so a frame
   * queued behind another, or a late completion callback, doesn't count its wait. Unlike the summed pass timestamps
   * below, overlapping passes count once (on Apple GPUs those sums exceed the frame).
   */
  gpuMs: number | null;
  /** Timestamp-query totals of the compute passes (the hair simulation) and the render passes. */
  gpuComputeMs: number | null;
  gpuRenderMs: number | null;
  hair: HairStats | null;
}

/** FPS / CPU / GPU timing HUD (GPU via WebGPU timestamp queries when available). */
export class Stats {
  readonly data: FrameStats = {
    fps: 0,
    cpuMs: 0,
    gpuMs: null,
    gpuComputeMs: null,
    gpuRenderMs: null,
    hair: null,
  };
  private gpuMin = Infinity;
  /** The quickest frame of each of the last four HUD updates (¼ s each). */
  private readonly gpuRecent: number[] = [];
  private frames = 0;
  private acc = 0;
  private lastHud = 0;
  private pendingSince = 0;
  private cpuStart = 0;
  private cpuAcc = 0;
  private cpuCount = 0;

  private readonly renderer: THREE.WebGPURenderer;
  private readonly el: HTMLElement;

  constructor(renderer: THREE.WebGPURenderer, el: HTMLElement) {
    this.renderer = renderer;
    this.el = el;
  }

  beginCpu(): void {
    this.cpuStart = performance.now();
  }

  endCpu(): void {
    this.cpuAcc += performance.now() - this.cpuStart;
    this.cpuCount++;
  }

  /** Call once a frame's GPU work has all been submitted: times it until the GPU is done. */
  markSubmitted(): void {
    const device = (this.renderer.backend as unknown as { device?: GPUDevice }).device;
    if (!device) return;
    const t0 = performance.now();
    void device.queue.onSubmittedWorkDone().then(() => {
      this.gpuMin = Math.min(this.gpuMin, performance.now() - t0);
    });
  }

  /** `view`: a line about the picture (resolution, antialiasing, quality) under the hair counts. */
  update(dt: number, hair: HairStats | null, extra: string[] = [], view = ''): void {
    this.frames++;
    this.acc += dt;
    this.data.hair = hair;
    // three.js expects timestamp queries to be resolved every frame (its query pool fills up otherwise). Skip while a
    // resolve is in flight, unless it has been stuck for 2 s.
    if (this.pendingSince === 0 || performance.now() - this.pendingSince > 2000)
      void this.resolveTimestamps();
    const now = performance.now();
    if (now - this.lastHud < 250) return;
    this.lastHud = now;
    this.data.fps = this.frames / Math.max(this.acc, 1e-6);
    this.data.cpuMs = this.cpuAcc / Math.max(1, this.cpuCount);
    if (this.gpuMin < Infinity) {
      this.gpuRecent.push(this.gpuMin);
      if (this.gpuRecent.length > 4) this.gpuRecent.shift();
      this.data.gpuMs = Math.min(...this.gpuRecent);
    }
    this.gpuMin = Infinity;
    this.frames = 0;
    this.acc = 0;
    this.cpuAcc = 0;
    this.cpuCount = 0;
    this.render(extra, view);
  }

  private async resolveTimestamps(): Promise<void> {
    const r = this.renderer as unknown as {
      resolveTimestampsAsync?: (type: string) => Promise<number | undefined>;
      hasFeature?: (name: string) => boolean;
    };
    if (!r.resolveTimestampsAsync || (r.hasFeature && !r.hasFeature('timestamp-query'))) return;
    this.pendingSince = performance.now();
    try {
      const [c, g] = await Promise.all([
        r.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE),
        r.resolveTimestampsAsync(THREE.TimestampQuery.RENDER),
      ]);
      // Light smoothing so the HUD is readable.
      if (typeof c === 'number' && c > 0)
        this.data.gpuComputeMs = this.data.gpuComputeMs === null ? c : this.data.gpuComputeMs * 0.8 + c * 0.2;
      if (typeof g === 'number' && g > 0)
        this.data.gpuRenderMs = this.data.gpuRenderMs === null ? g : this.data.gpuRenderMs * 0.8 + g * 0.2;
    } catch {
      // timestamp queries are best effort
    } finally {
      this.pendingSince = 0;
    }
  }

  private render(extra: string[], view: string): void {
    const d = this.data;
    const ms = (v: number | null) => (v === null ? '—' : v.toFixed(1));
    // Lines stay within ~37 characters, the width of the Groom Studio's panel.
    const lines = [
      `<b>${d.fps.toFixed(0).padStart(3)} fps</b>   cpu ${ms(d.cpuMs)} ms   gpu ${ms(d.gpuMs)} ms`,
    ];
    if (d.hair) {
      const h = d.hair;
      lines.push(
        `sim ${ms(d.gpuComputeMs)} ms   ${h.guides.toLocaleString()} guides`,
        `strands ${count(h.strandsActive)} / ${count(h.strandsTotal)}   ${count(h.vertices)} verts`,
      );
    }
    if (view) lines.push(view);
    lines.push(...extra);
    this.el.innerHTML = lines.join('\n');
  }
}

/** A count in at most 5 characters: 950, 12.3k, 98.6k, 1.37M. */
export function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}
