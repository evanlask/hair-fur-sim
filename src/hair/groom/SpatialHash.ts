/** Uniform-grid spatial hash over 3D points for radius / nearest queries. */
export class SpatialHash {
  private readonly cells = new Map<number, number[]>();
  private readonly inv: number;
  readonly points: Float32Array;
  private count = 0;

  readonly cellSize: number;

  constructor(cellSize: number, capacity: number) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    this.points = new Float32Array(capacity * 3);
  }

  private static key(ix: number, iy: number, iz: number): number {
    // Teschner et al. 2003. Distinct cells can collide, so callers must still check distances.
    return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  }

  insert(x: number, y: number, z: number): number {
    const id = this.count++;
    this.points[id * 3] = x;
    this.points[id * 3 + 1] = y;
    this.points[id * 3 + 2] = z;
    const k = SpatialHash.key(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(id);
    return id;
  }

  get size(): number {
    return this.count;
  }

  /** True if any point lies within `radius` (radius ≤ cellSize). */
  anyWithin(x: number, y: number, z: number, radius: number): boolean {
    const r2 = radius * radius;
    const cx = Math.floor(x * this.inv);
    const cy = Math.floor(y * this.inv);
    const cz = Math.floor(z * this.inv);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(SpatialHash.key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const id of list) {
            const ex = this.points[id * 3] - x;
            const ey = this.points[id * 3 + 1] - y;
            const ez = this.points[id * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez < r2) return true;
          }
        }
    return false;
  }

  /** Visits every point within `ring` cells of the query with its squared distance (unfiltered). */
  forEachNear(x: number, y: number, z: number, ring: number, visit: (id: number, d2: number) => void): void {
    const cx = Math.floor(x * this.inv);
    const cy = Math.floor(y * this.inv);
    const cz = Math.floor(z * this.inv);
    for (let dx = -ring; dx <= ring; dx++)
      for (let dy = -ring; dy <= ring; dy++)
        for (let dz = -ring; dz <= ring; dz++) {
          const list = this.cells.get(SpatialHash.key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const id of list) {
            const ex = this.points[id * 3] - x;
            const ey = this.points[id * 3 + 1] - y;
            const ez = this.points[id * 3 + 2] - z;
            visit(id, ex * ex + ey * ey + ez * ez);
          }
        }
  }
}
