import type { ColliderSet } from '../colliders';
import type { HairUniforms } from '../params';
import type { N } from './tslUtil';

/** Everything a group's kernels need (GPU buffers are TSL storage nodes). */
export interface GroupContext {
  /** Particles per guide. */
  G: number;
  /** Guide count. */
  Ng: number;
  /** Points per render strand. */
  R: number;
  /** Render strand count (allocated). */
  Ns: number;
  interpSpace: 'world' | 'root';
  u: HairUniforms;
  colliders: ColliderSet;
  /** Camera position and frustum planes (see HairLighting), for per-strand culling and LOD. */
  view: { cameraPos: N; frustumPlanes: N };
  /** Deformed growth mesh: [2i] world position, [2i+1] world normal. */
  deformed: N;
  /** Guide root triangle (uvec4: i0, i1, i2, collider mask). */
  guideRootTri: N;
  /** Guide barycentrics (vec4: u, v, w, guide length). */
  guideRootBary: N;
  /** Rest pose relative to the root, in the smooth root frame (vec4: local xyz, segment rest length). */
  guideRest: N;
  guidePos: N;
  guidePrev: N;
  /** 6 vec4 per guide: current (pos + guide length in w, t, n), previous (pos, t, n). */
  guideFrames: N;
  /**
   * vec4 per particle index k, shared by all guides:
   * (global stiffness mult, local stiffness mult, k/(G−1), 0).
   */
  profile: N;
  /**
   * Packed render-strand data, 4 uvec4 per strand:
   * [0] g0 (clump guide), g1, g2, two 16-bit seeds · [1] float bits w0, w1, w2, length ·
   * [2] root i0, i1, i2, RGBA8 color · [3] float bits u, v, w, width factor.
   */
  strandData: N;
  /** Render strand points (vec4: world xyz, world width). A negative width marks a culled strand. */
  renderPos: N;
  /**
   * Per render point (uvec4): shaded color half(r,g), half(b, alpha), and the strand tangent snorm(x,y), snorm(z).
   * All zero for points that aren't drawn (culled or hidden strands).
   */
  renderColor: N;
  /** Per strand (uint): 1 when it is on the far side of the body, so it isn't drawn (only used for shadows). */
  strandHidden: N;
  /** Temporally smoothed self-shadow transmittance per render point (vec2: key side, far side). */
  shadowHistory: N;
}
