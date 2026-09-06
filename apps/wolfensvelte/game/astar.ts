// A* over the tile grid with a binary heap and stamped scratch arrays, so a
// search allocates nothing and never touches the 4096 tiles it does not
// visit. Replaces helpers/ai.ts findPath (string-keyed Maps, O(n) open list).

export class PathFinder {
  private readonly w: number;
  private readonly h: number;
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly came: Int32Array;
  private readonly stamp: Int32Array;
  private readonly closed: Int32Array;
  private readonly heap: Int32Array;
  private heapSize = 0;
  private generation = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.heap = new Int32Array(n);
  }

  private push(i: number): void {
    const heap = this.heap;
    const f = this.f;
    let k = this.heapSize++;
    heap[k] = i;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (f[heap[parent]] <= f[heap[k]]) break;
      const t = heap[parent];
      heap[parent] = heap[k];
      heap[k] = t;
      k = parent;
    }
  }

  private pop(): number {
    const heap = this.heap;
    const f = this.f;
    const top = heap[0];
    const last = heap[--this.heapSize];
    if (this.heapSize > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < this.heapSize && f[heap[l]] < f[heap[m]]) m = l;
        if (r < this.heapSize && f[heap[r]] < f[heap[m]]) m = r;
        if (m === k) break;
        const t = heap[m];
        heap[m] = heap[k];
        heap[k] = t;
        k = m;
      }
    }
    return top;
  }

  /**
   * Tile indices from the step after (sx, sy) to (gx, gy), or to the visited
   * tile nearest the goal when it is unreachable within `maxExpand`. Empty
   * when already there or nothing is passable.
   */
  find(
    sx: number,
    sy: number,
    gx: number,
    gy: number,
    passable: (index: number) => boolean,
    maxExpand = 600,
  ): number[] {
    const w = this.w;
    const h = this.h;
    const gen = ++this.generation;
    const start = sy * w + sx;
    const goal = gy * w + gx;
    if (start === goal) return [];
    const heur = (i: number): number => {
      const x = i % w;
      const y = (i - x) / w;
      return Math.abs(x - gx) + Math.abs(y - gy);
    };
    this.heapSize = 0;
    this.g[start] = 0;
    this.f[start] = heur(start);
    this.came[start] = -1;
    this.stamp[start] = gen;
    this.push(start);
    let best = start;
    let bestH = this.f[start];
    let expanded = 0;
    while (this.heapSize > 0 && expanded < maxExpand) {
      const cur = this.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      expanded++;
      if (cur === goal) {
        best = cur;
        break;
      }
      const hc = this.f[cur] - this.g[cur];
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      const x = cur % w;
      const y = (cur - x) / w;
      const gNext = this.g[cur] + 1;
      for (let d = 0; d < 4; d++) {
        const nx = d === 0 ? x - 1 : d === 1 ? x + 1 : x;
        const ny = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (this.closed[n] === gen) continue;
        if (n !== goal && !passable(n)) continue;
        if (this.stamp[n] === gen && this.g[n] <= gNext) continue;
        this.stamp[n] = gen;
        this.g[n] = gNext;
        this.f[n] = gNext + heur(n);
        this.came[n] = cur;
        this.push(n);
      }
    }
    const path: number[] = [];
    for (let i = best; i !== start && i >= 0; i = this.came[i]) path.push(i);
    path.reverse();
    return path;
  }
}
