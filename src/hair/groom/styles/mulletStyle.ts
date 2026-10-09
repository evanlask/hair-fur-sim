import * as THREE from 'three/webgpu';

import type { GroomStyle, SurfacePoint } from '../types';

/** Lee Perry-Smith model-space landmarks (model units; 1 unit ≈ 5.3 cm). */
const LPS = {
  craniumCenter: new THREE.Vector3(-0.073, 2.159, 0.079),
  midlineX: -0.08,
  // Ear ellipsoids (center, radii), tight around the ear itself (it protrudes over z ≈ −0.25…0.3 and
  // reaches y ≈ 1.95 at its top front), so hair grows right down to the top of the ear but never out of it.
  ears: [
    { c: new THREE.Vector3(-1.8, 1.36, -0.03), r: new THREE.Vector3(0.36, 0.74, 0.46) },
    { c: new THREE.Vector3(1.64, 1.36, -0.03), r: new THREE.Vector3(0.36, 0.74, 0.46) },
  ],
};

export interface MulletStyleParams {
  /** Model units → world: world = origin + model × scale (bind pose, no rotation). */
  modelScale: number;
  modelOrigin: THREE.Vector3;
  /** Hairline offset (model units, + lowers the hairline). */
  hairlineOffset: number;
  topLength: number;
  frontLength: number;
  sideLength: number;
  backLength: number;
  /** Where the back ("party") starts, in degrees from the front. */
  partyStart: number;
  /** How far the party extends up the back of the head (model y). */
  partyTop: number;
  lift: number;
  perm: number;
  businessGuides: number;
  businessStrands: number;
  partyGuides: number;
  partyStrands: number;
  businessParticles: number;
  businessPoints: number;
  partyParticles: number;
  partyPoints: number;
}

export const defaultMulletStyle = (): Omit<MulletStyleParams, 'modelScale' | 'modelOrigin'> => ({
  hairlineOffset: 0,
  topLength: 0.065,
  frontLength: 0.065,
  sideLength: 0.036,
  backLength: 0.26,
  partyStart: 104,
  partyTop: 3.1,
  lift: 0.6,
  perm: 0.014,
  businessGuides: 1800,
  businessStrands: 60000,
  partyGuides: 1300,
  partyStrands: 48000,
  businessParticles: 12,
  businessPoints: 12,
  partyParticles: 20,
  partyPoints: 28,
});

/** Hairline height (model y) by azimuth |θ| in degrees (0 = front, 180 = back). */
const HAIRLINE: [number, number][] = [
  [0, 3.3],
  [25, 3.05],
  [45, 2.45],
  [70, 2.1],
  [84, 2.05], // above the front of the ear (no hair in front of / over the ear)
  [96, 1.75], // above and behind the ear
  [106, 1.25],
  [115, 0.95],
  [135, 0.15],
  [160, -0.3],
  [180, -0.45],
];

function lerpTable(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      const t = (x - x0) / (x1 - x0);
      const s = t * t * (3 - 2 * t);
      return y0 + (y1 - y0) * s;
    }
  }
  return table[table.length - 1][1];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 1980s mullet on the Lee Perry-Smith scan: short feathered "business", long "party" back. */
export function createMulletStyle(p: MulletStyleParams): GroomStyle {
  const m = new THREE.Vector3();
  const toModel = (sp: SurfacePoint) => m.copy(sp.position).sub(p.modelOrigin).divideScalar(p.modelScale);
  const azimuth = (q: THREE.Vector3) =>
    (Math.atan2(q.x - LPS.midlineX, q.z - LPS.craniumCenter.z) * 180) / Math.PI;
  const earMask = (q: THREE.Vector3) => {
    let k = 0;
    for (const e of LPS.ears) {
      const dx = (q.x - e.c.x) / e.r.x;
      const dy = (q.y - e.c.y) / e.r.y;
      const dz = (q.z - e.c.z) / e.r.z;
      k = Math.max(k, 1 - smoothstep(0.85, 1.05, Math.sqrt(dx * dx + dy * dy + dz * dz)));
    }
    return k;
  };
  /**
   * 0 = business, 1 = party. The bands are wide so the cut is graduated: strands belong to one group
   * (the 0.5 crossing), but length, comb and bend blend smoothly across the band.
   */
  const partyness = (q: THREE.Vector3) => {
    const th = Math.abs(azimuth(q));
    return (
      smoothstep(p.partyStart - 28, p.partyStart + 22, th) *
      smoothstep(p.partyTop + 1.1, p.partyTop - 1.0, q.y)
    );
  };
  const DOWN = new THREE.Vector3(0, -1, 0);
  const BACK = new THREE.Vector3(0, 0, -1);
  const comb = new THREE.Vector3();
  const dirTmp = new THREE.Vector3();
  const businessDir = new THREE.Vector3();
  const businessBend = new THREE.Vector3();
  const partyDir = new THREE.Vector3();
  const partyBend = new THREE.Vector3();

  const scalpDensity = (sp: SurfacePoint) => {
    const q = toModel(sp);
    const th = Math.abs(azimuth(q));
    const line = lerpTable(HAIRLINE, th) - p.hairlineOffset;
    const above = smoothstep(line - 0.1, line + 0.15, q.y);
    return above * (1 - earMask(q));
  };

  return {
    groups: [
      {
        name: 'business',
        guideCount: p.businessGuides,
        strandCount: p.businessStrands,
        guideParticles: p.businessParticles,
        strandPoints: p.businessPoints,
        lengthVariation: 0.3,
        widthVariation: 0.3,
        interpSpace: 'world',
      },
      {
        name: 'party',
        guideCount: p.partyGuides,
        strandCount: p.partyStrands,
        guideParticles: p.partyParticles,
        strandPoints: p.partyPoints,
        lengthVariation: 0.25,
        widthVariation: 0.3,
        interpSpace: 'world',
      },
    ],
    density(sp) {
      return scalpDensity(sp);
    },
    group(sp) {
      return partyness(toModel(sp)) > 0.5 ? 1 : 0;
    },
    shape(sp, out) {
      const q = toModel(sp);
      const ath = Math.abs(azimuth(q));
      const n = sp.normal;
      // Business: top swept back with feathered lift, front bangs up/back, short sides.
      const front = 1 - smoothstep(20, 55, ath);
      const side = smoothstep(55, 95, ath) * smoothstep(2.9, 2.2, q.y);
      const top = 1 - Math.max(front, side);
      // Back of the crown: lies flat and combs down the scalp into the party (layered, no shelf).
      const back = smoothstep(95, 150, ath);
      // Rear half of the top: follows the skull down over the crown instead of jutting out backwards.
      const crown = smoothstep(0.2, -1.4, q.z - LPS.craniumCenter.z) * top;
      const businessLength =
        (p.topLength * top + p.frontLength * front + p.sideLength * side) * (1 - 0.25 * crown);
      // Comb direction: backwards over the top/front, down-back on the sides, down at the back.
      // Sides sweep back over the top of the ear rather than falling down over it.
      dirTmp
        .copy(BACK)
        .multiplyScalar((1 - side) * (1 - back))
        .addScaledVector(DOWN, side * 0.35 + back * 1.2)
        .addScaledVector(BACK, side * 1.0);
      comb.copy(dirTmp).addScaledVector(n, -n.dot(dirTmp));
      if (comb.lengthSq() < 1e-4) comb.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
      comb.normalize();
      const lift = Math.min(
        0.9,
        p.lift * (0.6 * top + 1.1 * front + 0.25 * side) * (1 - 0.85 * back) * (1 - 0.7 * crown),
      );
      businessDir
        .copy(n)
        .multiplyScalar(lift)
        .addScaledVector(comb, 1 - lift)
        .normalize();
      businessBend
        .copy(comb)
        .addScaledVector(DOWN, 0.2 + 0.35 * top + 0.8 * back + 1.5 * crown)
        .normalize();

      // Party: long back falling down the neck with a slight perm wave.
      const lower = smoothstep(p.partyTop, 0.0, q.y);
      const partyLength = p.backLength * (0.75 + 0.25 * lower);
      comb.copy(DOWN).addScaledVector(n, -n.dot(DOWN));
      if (comb.lengthSq() < 1e-4) comb.copy(BACK);
      comb.normalize();
      // Lies flat where it meets the crown, lifting a little lower down for volume at the nape.
      const partyLift = 0.12 + 0.33 * lower;
      partyDir
        .copy(n)
        .multiplyScalar(partyLift)
        .addScaledVector(comb, 1 - partyLift)
        .normalize();
      partyBend.copy(DOWN).addScaledVector(BACK, 0.35).normalize();

      // Graduated cut: everything blends across the band; length eases in so the business side
      // lengthens gently towards the back instead of meeting the party at a hard line.
      const w = partyness(q);
      const wl = w * w;
      // Ragged ends towards the back so the crown layer doesn't end in one line above the party.
      const h = Math.sin(q.x * 127.1 + q.y * 311.7 + q.z * 74.7) * 43758.5453;
      const ragged = 1 + 0.5 * back * (1 - w) * (h - Math.floor(h) - 0.5);
      out.length = (businessLength + (partyLength - businessLength) * wl) * ragged;
      out.direction.copy(businessDir).lerp(partyDir, w).normalize();
      out.bendTarget.copy(businessBend).lerp(partyBend, w).normalize();
      const businessBendRate = 8 + 4 * top + 14 * side + 6 * back + 10 * crown;
      out.bendRate = businessBendRate + (11 - businessBendRate) * w;
      out.waveAmplitude = p.perm * (0.25 + 0.75 * w);
      out.waveCount = 1.2 + 1.3 * w;
    },
  };
}

/** Per-vertex scalp mask (0..1) for tinting the skin under the hair. */
export function scalpMask(style: GroomStyle, positions: Float32Array, normals: Float32Array): Float32Array {
  const out = new Float32Array(positions.length / 3);
  const sp: SurfacePoint = {
    tri: 0,
    u: 1,
    v: 0,
    w: 0,
    position: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    uv: null,
    bones: null,
  };
  for (let i = 0; i < out.length; i++) {
    sp.position.fromArray(positions, i * 3);
    sp.normal.fromArray(normals, i * 3);
    out[i] = style.density(sp, style.group(sp));
  }
  return out;
}
