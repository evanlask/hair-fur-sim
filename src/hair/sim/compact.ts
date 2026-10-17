import * as THREE from 'three/webgpu';

import { tsl } from './tsl';
import type { N } from './tslUtil';

const { Fn, atomicAdd, atomicLoad, atomicStore, clamp, storage, uint, uniform } = tsl;

/** Set in a draw list entry when the strand wasn't drawn last frame (its shading history is stale). */
export const FRESH_BIT = 0x80000000;
/** Workgroup size of the shade kernel (see buildShadeKernel). */
const SHADE_WORKGROUP = 64;
/** WebGPU's guaranteed maxComputeWorkgroupsPerDimension: larger shade dispatches spill into y. */
const MAX_GROUPS_X = 65535;
/** `lists` header: append counters (draw, shadow), then this frame's lengths (draw, shadow). */
const HEADER = 4;
/** `args` layout (uints): shade dispatch (x, y, z) at 0, as dispatchWorkgroupsIndirect reads from the start. */
const DRAW_ARGS = 3;
const SHADOW_ARGS = 8;

export interface StrandCompactionOptions {
  /** Points per render strand. */
  R: number;
  /** Render strands allocated. */
  Ns: number;
  /** Strands per ribbon draw instance (STRANDS_PER_INSTANCE). */
  strandsPerInstance: number;
  /** Index count of the shadow ribbon geometry (fixed). */
  shadowIndexCount: number;
  /** Zero-filled CPU memory for the GPU-only buffers (at least 3·Ns + 4 uints); see HairGroup. */
  zeros: ArrayBuffer;
}

/**
 * Visible-strand compaction (opt-in, `HairInstanceOptions.compactStrands`). The interpolate kernel appends every
 * strand it keeps to a draw list (and to a shadow list, for the shadow map's prefix of strands), and the shade
 * kernel, the strand draw and the shadow draw then run over those lists only, through indirect dispatches and
 * draws. Without it, culled and LOD-thinned strands still cost a full ribbon in every pass (collapsed to zero area).
 *
 * Everything lives in one storage buffer (`lists`) and one indirect buffer (`args`), as the kernels are close to
 * the per-stage storage buffer limit: header · draw list (Ns) · shadow list (Ns) · per-strand last drawn frame (Ns).
 */
export class StrandCompaction {
  readonly Ns: number;
  /** The lists buffer, plain (shade kernel, vertex shaders) and atomic (interpolate, finalize): one GPU buffer. */
  readonly lists: N;
  readonly listsAtomic: N;
  /** Indirect arguments: shade dispatch, then drawIndexedIndirect for the strands and for the shadow map. */
  readonly args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(13), 1);
  /** Byte offsets into `args` for BufferGeometry.setIndirect. */
  readonly drawArgsOffset = DRAW_ARGS * 4;
  readonly shadowArgsOffset = SHADOW_ARGS * 4;
  /** Frame number, advanced before each interpolate (see `nextFrame`); a last drawn frame of 0 = never drawn. */
  readonly frame: N = uniform(1, 'uint');
  /** Index count of the current strand ribbon geometry (it changes with the draw LOD stride). */
  readonly drawIndexCount: N = uniform(0, 'uint');
  /** One thread: turns the counters into this frame's lengths and indirect arguments, then clears them. */
  readonly finalize: N;

  constructor(o: StrandCompactionOptions) {
    this.Ns = o.Ns;
    const attr = new THREE.StorageBufferAttribute(new Uint32Array(o.zeros, 0, HEADER + 3 * o.Ns), 1);
    this.lists = storage(attr, 'uint', attr.count);
    this.listsAtomic = storage(attr, 'uint', attr.count).toAtomic();

    const K = o.strandsPerInstance;
    const args = storage(this.args, 'uint', 13);
    const lists = this.listsAtomic;
    this.finalize = (
      Fn(() => {
        const n = atomicLoad(lists.element(0)).toVar();
        const ns = atomicLoad(lists.element(1)).toVar();
        atomicStore(lists.element(0), uint(0));
        atomicStore(lists.element(1), uint(0));
        atomicStore(lists.element(2), n);
        atomicStore(lists.element(3), ns);
        // One thread per drawn point; past the per-dimension limit the workgroups wrap into y.
        const groups = n
          .mul(o.R)
          .add(SHADE_WORKGROUP - 1)
          .div(SHADE_WORKGROUP)
          .toVar();
        const gx = clamp(groups, uint(1), uint(MAX_GROUPS_X)).toVar();
        args.element(0).assign(gx);
        args.element(1).assign(groups.add(gx.sub(1)).div(gx));
        args.element(2).assign(uint(1));
        // (First index, base vertex and first instance stay 0.)
        args.element(DRAW_ARGS).assign(this.drawIndexCount);
        args.element(DRAW_ARGS + 1).assign(n.add(K - 1).div(K));
        args.element(SHADOW_ARGS).assign(uint(o.shadowIndexCount));
        args.element(SHADOW_ARGS + 1).assign(ns.add(K - 1).div(K));
      }) as N
    )()
      .compute(1, [1])
      .setName('hair.compactFinalize');
  }

  /** This frame's draw / shadow list lengths (plain view; valid after `finalize`). */
  drawCount(): N {
    return this.lists.element(2);
  }

  shadowCount(): N {
    return this.lists.element(3);
  }

  /** Draw / shadow list entry at `slot` (plain view). */
  drawEntry(slot: N): N {
    return this.lists.element(slot.add(HEADER));
  }

  shadowEntry(slot: N): N {
    return this.lists.element(slot.add(HEADER + this.Ns));
  }

  /** Interpolate: appends a strand to the shadow list. */
  appendShadow(strand: N): void {
    const lists = this.listsAtomic;
    atomicStore(lists.element(atomicAdd(lists.element(1), uint(1)).add(HEADER + this.Ns)), strand);
  }

  /** Interpolate: appends a strand to the draw list, flagged fresh if it wasn't on it last frame. */
  appendDraw(strand: N): void {
    const lists = this.listsAtomic;
    const last = lists.element(strand.add(HEADER + 2 * this.Ns));
    const fresh = atomicLoad(last).add(1).notEqual(this.frame).toVar();
    atomicStore(last, this.frame);
    const entry = strand.bitOr(fresh.select(uint(FRESH_BIT), uint(0)));
    atomicStore(lists.element(atomicAdd(lists.element(0), uint(1)).add(HEADER)), entry);
  }

  /** Advances the frame number (call when interpolate runs this frame). */
  nextFrame(): void {
    this.frame.value = (this.frame.value as number) + 1;
  }

  /** Storage nodes / attributes to free on dispose (see ReleaseBuffers). */
  buffers(): N[] {
    return [this.lists, { value: this.args }];
  }

  dispose(): void {
    this.finalize.dispose();
  }
}
