import * as THREE from 'three/webgpu';

import type { HairStats } from '../hair/HairSystem';

export interface FrameStats {
  fps: number;
  cpuMs: number;
  gpuComputeMs: number | null;
  gpuRenderMs: number | null;
  hair: HairStats | null;
}

/** FPS / CPU / GPU timing HUD (GPU via WebGPU timestamp queries when available). */
export class Stats {
  readonly data: FrameStats = { fps: 0, cpuMs: 0, gpuComputeMs: null, gpuRenderMs: null, hair: null };
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

  update(dt: number, hair: HairStats | null, extra: string[] = []): void {
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
    this.frames = 0;
    this.acc = 0;
    this.cpuAcc = 0;
    this.cpuCount = 0;
    this.render(extra);
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

  private render(extra: string[]): void {
    const d = this.data;
    const f = (v: number | null) => (v === null ? '  —  ' : v.toFixed(2).padStart(5));
    const lines = [
      `<b>${d.fps.toFixed(0).padStart(3)} fps</b>   cpu ${d.cpuMs.toFixed(2)} ms`,
      `gpu compute ${f(d.gpuComputeMs)} ms   render ${f(d.gpuRenderMs)} ms`,
    ];
    if (d.hair) {
      const h = d.hair;
      lines.push(
        `guides ${h.guides.toLocaleString()} (${h.guideParticles.toLocaleString()} particles)`,
        `strands ${h.strandsActive.toLocaleString()} / ${h.strandsTotal.toLocaleString()}   verts ${(h.vertices / 1e6).toFixed(2)}M`,
      );
    }
    lines.push(...extra);
    this.el.innerHTML = lines.join('\n');
  }
}
