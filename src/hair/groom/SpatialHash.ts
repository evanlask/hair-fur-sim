/** Uniform-grid spatial hash over 3D points for radius / nearest queries. */
export class SpatialHash {
  private readonly cells = new Map<number, number[]>();
  private readonly inv: number;
  readonly points: Float32Array;
  private count = 0;
  private grid: DenseGrid | null = null;

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
    this.grid = null;
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

  /**
   * Visits every point within `ring` cells of the query with its squared distance (unfiltered), cell by cell
   * in insertion order. Queries a dense grid built on first use, so insert everything first.
   */
  forEachNear(x: number, y: number, z: number, ring: number, visit: (id: number, d2: number) => void): void {
    const grid = (this.grid ??= this.buildGrid());
    const { min, dims, start, ids } = grid;
    const cx = Math.floor(x * this.inv) - min[0];
    const cy = Math.floor(y * this.inv) - min[1];
    const cz = Math.floor(z * this.inv) - min[2];
    // Clamped to occupied cells, so a flat field doesn't probe the empty layers above and below it.
    const x1 = Math.min(cx + ring, dims[0] - 1);
    const y1 = Math.min(cy + ring, dims[1] - 1);
    const z1 = Math.min(cz + ring, dims[2] - 1);
    for (let ix = Math.max(cx - ring, 0); ix <= x1; ix++)
      for (let iy = Math.max(cy - ring, 0); iy <= y1; iy++)
        for (let iz = Math.max(cz - ring, 0); iz <= z1; iz++) {
          const c = (ix * dims[1] + iy) * dims[2] + iz;
          for (let j = start[c], end = start[c + 1]; j < end; j++) {
            const id = ids[j];
            const ex = this.points[id * 3] - x;
            const ey = this.points[id * 3 + 1] - y;
            const ez = this.points[id * 3 + 2] - z;
            visit(id, ex * ex + ey * ey + ez * ez);
          }
        }
  }

  /** Bins the points into a dense grid over their bounds (counting sort keeps insertion order per cell). */
  private buildGrid(): DenseGrid {
    const n = this.count;
    const cell = new Int32Array(n * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n * 3; i++) {
      const c = (cell[i] = Math.floor(this.points[i] * this.inv));
      min[i % 3] = Math.min(min[i % 3], c);
      max[i % 3] = Math.max(max[i % 3], c);
    }
    if (n === 0) {
      min.fill(0);
      max.fill(-1);
    }
    const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    const start = new Int32Array(dims[0] * dims[1] * dims[2] + 1);
    const flat = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      flat[i] =
        ((cell[i * 3] - min[0]) * dims[1] + cell[i * 3 + 1] - min[1]) * dims[2] + cell[i * 3 + 2] - min[2];
      start[flat[i] + 1]++;
    }
    for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
    const fill = start.slice(0, -1);
    const ids = new Int32Array(n);
    for (let i = 0; i < n; i++) ids[fill[flat[i]]++] = i;
    return { min, dims, start, ids };
  }
}

interface DenseGrid {
  /** Cell index of the grid's first cell, and the cell counts per axis. */
  min: number[];
  dims: number[];
  /** Points of cell c are ids[start[c]] .. ids[start[c + 1] - 1]. */
  start: Int32Array;
  ids: Int32Array;
}
