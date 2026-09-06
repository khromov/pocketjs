// Billboard projection for decorations, pickups and enemies: camera-space
// transform, far-to-near sort, and the visible column run each sprite keeps
// against the wall z-buffer. Output arrays are preallocated and reused.

import type { Enemy } from "./enemies.ts";
import type { Camera } from "./raycast.ts";
import type { World } from "./world.ts";

export class SpriteCollector {
  /** Sprites to draw this frame, far to near. */
  count = 0;
  readonly cell: Uint16Array;
  /** Screen box: left, top, size (square). */
  readonly left: Float32Array;
  readonly top: Float32Array;
  readonly size: Float32Array;
  readonly depth: Float32Array;
  /** Visible horizontal run [a, b) after wall occlusion. */
  readonly runA: Float32Array;
  readonly runB: Float32Array;

  private readonly candCell: Uint16Array;
  private readonly candX: Float32Array;
  private readonly candY: Float32Array;
  private readonly candDepth: Float32Array;
  private readonly order: Int32Array;

  constructor(maxCandidates: number, maxOut: number) {
    this.cell = new Uint16Array(maxOut);
    this.left = new Float32Array(maxOut);
    this.top = new Float32Array(maxOut);
    this.size = new Float32Array(maxOut);
    this.depth = new Float32Array(maxOut);
    this.runA = new Float32Array(maxOut);
    this.runB = new Float32Array(maxOut);
    this.candCell = new Uint16Array(maxCandidates);
    this.candX = new Float32Array(maxCandidates);
    this.candY = new Float32Array(maxCandidates);
    this.candDepth = new Float32Array(maxCandidates);
    this.order = new Int32Array(maxCandidates);
  }

  collect(
    world: World,
    enemies: readonly Enemy[],
    cam: Camera,
    projDist: number,
    viewW: number,
    viewH: number,
    zbuf: Float32Array,
    stripW: number,
  ): void {
    const invDet = 1 / (cam.planeX * cam.dirY - cam.dirX * cam.planeY);
    let n = 0;
    const candX = this.candX;
    const candY = this.candY;
    const candDepth = this.candDepth;
    const candCell = this.candCell;
    const maxCand = candX.length;

    const consider = (wx: number, wy: number, cell: number): void => {
      if (n >= maxCand) return;
      const relX = wx - cam.x;
      const relY = wy - cam.y;
      const tx = invDet * (cam.dirY * relX - cam.dirX * relY);
      const ty = invDet * (-cam.planeY * relX + cam.planeX * relY);
      if (ty <= 0.1) return;
      const s = projDist / ty;
      const cx = (viewW / 2) * (1 + tx / ty);
      if (cx + s / 2 < 0 || cx - s / 2 > viewW) return;
      candX[n] = cx;
      candY[n] = s;
      candDepth[n] = ty;
      candCell[n] = cell;
      n++;
    };

    for (const o of world.objects) {
      if (o.alive) consider(o.x + 0.5, o.y + 0.5, o.cell);
    }
    for (const e of enemies) consider(e.x, e.y, e.cell);

    // Far to near (painter order); insertion sort keeps this allocation-free
    // and the list is a few dozen at most.
    const order = this.order;
    for (let i = 0; i < n; i++) {
      let j = i;
      while (j > 0 && candDepth[order[j - 1]] < candDepth[i]) {
        order[j] = order[j - 1];
        j--;
      }
      order[j] = i;
    }

    const cols = zbuf.length;
    let out = 0;
    const maxOut = this.cell.length;
    // The nearest `maxOut` win when more are on screen: walk from the far end
    // but skip the farthest overflow first.
    const skip = Math.max(0, n - maxOut);
    for (let k = skip; k < n; k++) {
      const i = order[k];
      const s = candY[i];
      const l = candX[i] - s / 2;
      const d = candDepth[i];
      let c0 = Math.floor(l / stripW);
      let c1 = Math.ceil((l + s) / stripW);
      if (c0 < 0) c0 = 0;
      if (c1 > cols) c1 = cols;
      // Longest run of columns where the wall is behind the sprite.
      let bestA = 0;
      let bestB = 0;
      let runStart = -1;
      for (let c = c0; c <= c1; c++) {
        const visible = c < c1 && zbuf[c] > d;
        if (visible && runStart < 0) runStart = c;
        if (!visible && runStart >= 0) {
          if (c - runStart > bestB - bestA) {
            bestA = runStart;
            bestB = c;
          }
          runStart = -1;
        }
      }
      if (bestB <= bestA) continue;
      let a = bestA * stripW;
      let b = bestB * stripW;
      if (a < l) a = l;
      if (b > l + s) b = l + s;
      if (b - a < 0.5) continue;
      this.cell[out] = candCell[i];
      this.left[out] = l;
      this.top[out] = viewH / 2 - s / 2;
      this.size[out] = s;
      this.depth[out] = d;
      this.runA[out] = a;
      this.runB[out] = b;
      out++;
    }
    this.count = out;
  }
}
