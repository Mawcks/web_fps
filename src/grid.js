/**
 * The carve grid.
 *
 * The world is solid rock. The player carves rectangular rooms out of it.
 * Everything is tracked as a list of ops (carve / fill) over an integer cell
 * grid; the set of open cells is replayed from those ops. Walls, floor and
 * ceiling are all derived from the open-cell set, so overlapping rooms merge
 * into one connected space and shared edges become open doorways for free.
 */

export const CELL = 1; // world units per grid cell
export const ROOM_HEIGHT = 4; // height of carved space / walls
export const SAVE_VERSION = 1;

const key = (x, z) => x + ',' + z;
const parseKey = (k) => {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
};

export class Grid {
  constructor() {
    this.ops = []; // { type: 'carve' | 'fill', x, z, w, d } — rect in cell coords
    this._open = new Set(); // cached open-cell keys
    this._dirty = true;
  }

  /** Record a carve/fill rectangle. x,z is the min corner; w,d the size in cells. */
  addOp(type, x, z, w, d) {
    if (w <= 0 || d <= 0) return;
    this.ops.push({ type, x: x | 0, z: z | 0, w: w | 0, d: d | 0 });
    this._dirty = true;
  }

  undo() {
    if (this.ops.length === 0) return false;
    this.ops.pop();
    this._dirty = true;
    return true;
  }

  clear() {
    this.ops.length = 0;
    this._dirty = true;
  }

  _rebuild() {
    const open = this._open;
    open.clear();
    for (const op of this.ops) {
      for (let dz = 0; dz < op.d; dz++) {
        for (let dx = 0; dx < op.w; dx++) {
          const k = key(op.x + dx, op.z + dz);
          if (op.type === 'carve') open.add(k);
          else open.delete(k);
        }
      }
    }
    this._dirty = false;
  }

  /** Set of open-cell keys ("x,z"). Lazily replayed from ops. */
  get open() {
    if (this._dirty) this._rebuild();
    return this._open;
  }

  get isEmpty() {
    return this.open.size === 0;
  }

  isOpen(x, z) {
    return this.open.has(key(x, z));
  }

  /** Bounding box of the carved space in cell coords, or null if empty. */
  bounds() {
    const open = this.open;
    if (open.size === 0) return null;
    let minX = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxZ = -Infinity;
    for (const k of open) {
      const [x, z] = parseKey(k);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // maxX/maxZ are inclusive cell indices; +1 gives the outer edge.
    return { minX, minZ, maxX: maxX + 1, maxZ: maxZ + 1 };
  }

  /** World-space center of the most interior open cell — a safe spawn point. */
  spawnPoint() {
    const open = this.open;
    if (open.size === 0) return { x: 0.5, z: 0.5 };
    let cx = 0,
      cz = 0;
    for (const k of open) {
      const [x, z] = parseKey(k);
      cx += x;
      cz += z;
    }
    cx /= open.size;
    cz /= open.size;
    let best = null,
      bestScore = -Infinity;
    for (const k of open) {
      const [x, z] = parseKey(k);
      // prefer cells with open neighbours, then closeness to the centroid
      let openNeighbours = 0;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (open.has(key(x + dx, z + dz))) openNeighbours++;
      }
      const dist2 = (x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2;
      const score = openNeighbours * 1000 - dist2;
      if (score > bestScore) {
        bestScore = score;
        best = { x: x + 0.5, z: z + 0.5 };
      }
    }
    return best;
  }

  /** Random world-space points at the centers of open cells. */
  randomOpenPoints(count) {
    const cells = [...this.open];
    const out = [];
    for (let i = 0; i < count && cells.length; i++) {
      const [x, z] = parseKey(cells[(Math.random() * cells.length) | 0]);
      out.push({ x: x + 0.5, z: z + 0.5 });
    }
    return out;
  }

  /**
   * Derive merged wall segments from the open-cell boundary.
   *
   * A wall sits on any edge between an open cell and a solid cell. Collinear
   * runs are merged into single spans to keep mesh/collider counts low.
   * Returns: { axis: 'x'|'z', line, start, end, side } where for axis 'x' the
   * span runs along X at Z=line, and `side` records which side is solid.
   */
  walls() {
    const open = this.open;
    const xRuns = new Map(); // `${lineZ}|${side}` -> Set<x>  (walls running along X)
    const zRuns = new Map(); // `${lineX}|${side}` -> Set<z>  (walls running along Z)

    const add = (map, k, v) => {
      let s = map.get(k);
      if (!s) map.set(k, (s = new Set()));
      s.add(v);
    };

    for (const k of open) {
      const [x, z] = parseKey(k);
      if (!open.has(key(x, z - 1))) add(xRuns, z + '|n', x);
      if (!open.has(key(x, z + 1))) add(xRuns, z + 1 + '|s', x);
      if (!open.has(key(x - 1, z))) add(zRuns, x + '|w', z);
      if (!open.has(key(x + 1, z))) add(zRuns, x + 1 + '|e', z);
    }

    const segs = [];
    const flush = (map, axis) => {
      for (const [mapKey, set] of map) {
        const sep = mapKey.indexOf('|');
        const line = Number(mapKey.slice(0, sep));
        const side = mapKey.slice(sep + 1);
        const arr = [...set].sort((a, b) => a - b);
        let runStart = arr[0];
        let prev = arr[0];
        for (let i = 1; i <= arr.length; i++) {
          if (i < arr.length && arr[i] === prev + 1) {
            prev = arr[i];
            continue;
          }
          segs.push({ axis, line, start: runStart, end: prev + 1, side });
          if (i < arr.length) {
            runStart = arr[i];
            prev = arr[i];
          }
        }
      }
    };
    flush(xRuns, 'x');
    flush(zRuns, 'z');
    return segs;
  }

  toJSON() {
    return { version: SAVE_VERSION, ops: this.ops };
  }

  loadJSON(data) {
    if (!data || !Array.isArray(data.ops)) throw new Error('Invalid map data');
    this.ops = data.ops
      .filter((o) => o && (o.type === 'carve' || o.type === 'fill'))
      .map((o) => ({ type: o.type, x: o.x | 0, z: o.z | 0, w: o.w | 0, d: o.d | 0 }));
    this._dirty = true;
  }
}
