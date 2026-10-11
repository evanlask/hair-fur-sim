/**
 * Smooth, area-weighted vertex normals computed on a position-welded copy of the mesh, so
 * vertices split at UV seams still share one normal (no seams in fur direction or shading).
 */
export function weldedNormals(
  positions: Float32Array,
  indices: ArrayLike<number>,
  quantum = 1e-5,
): Float32Array {
  const n = positions.length / 3;
  const { groupOf, count } = weldGroups(positions, quantum);
  const acc = new Float32Array(count * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const e1x = positions[b * 3] - positions[a * 3];
    const e1y = positions[b * 3 + 1] - positions[a * 3 + 1];
    const e1z = positions[b * 3 + 2] - positions[a * 3 + 2];
    const e2x = positions[c * 3] - positions[a * 3];
    const e2y = positions[c * 3 + 1] - positions[a * 3 + 1];
    const e2z = positions[c * 3 + 2] - positions[a * 3 + 2];
    // Unnormalized cross product = area-weighted face normal.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      const g = groupOf[v];
      acc[g * 3] += nx;
      acc[g * 3 + 1] += ny;
      acc[g * 3 + 2] += nz;
    }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = groupOf[i];
    const x = acc[g * 3];
    const y = acc[g * 3 + 1];
    const z = acc[g * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l;
    out[i * 3 + 1] = y / l;
    out[i * 3 + 2] = z / l;
  }
  return out;
}

/** Groups vertices at the same position (within `quantum`): `groupOf[i]` numbers them 0…count−1 in first-seen order. */
export function weldGroups(positions: Float32Array, quantum = 1e-5): { groupOf: Int32Array; count: number } {
  const n = positions.length / 3;
  const key = (i: number) =>
    `${Math.round(positions[i * 3] / quantum)},${Math.round(positions[i * 3 + 1] / quantum)},${Math.round(positions[i * 3 + 2] / quantum)}`;
  const groupOf = new Int32Array(n);
  const groups = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    let g = groups.get(k);
    if (g === undefined) groups.set(k, (g = groups.size));
    groupOf[i] = g;
  }
  return { groupOf, count: groups.size };
}
