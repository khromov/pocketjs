// The 3D view as retained native nodes: a pool of wall column strips and a
// pool of sprite slots, every per-frame value written through one jump batch
// (one setPropBatch crossing per frame).
//
// A wall strip is an overflow-hidden view, STRIP_W wide and the view tall,
// holding the 512x512 wall atlas as an image with a top-left origin. The core
// clips the scaled atlas to the strip and re-interpolates UVs, so setting the
// image's scaleY/translateX/translateY selects one texture column at one wall
// height. A sprite slot is the same shape at 64x64, with the wrapper scaled to
// the sprite's visible run and the child counter-scaled so the whole sprite
// keeps its size while the run clips it against nearer walls.
//
// The small texel bias on the atlas offsets keeps the PSP's integer texel UVs
// inside the intended cell when f32 rounding lands a hair under a cell edge. It
// stays under 1/8 texel: a 4 px strip samples its texel at 1/8, 3/8, 5/8 and
// 7/8, and a larger bias would push the last pixel into the next column.

import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/svelte/animation";
import {
  createElement,
  detachNode,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/svelte/renderer";
import { ATLAS_COLS, ATLAS_SIZE, CELL_SIZE, SPRITE_ATLAS, WALL_ATLAS } from "../game/atlas.ts";

// spec ENUMS.PosType.Absolute / ENUMS.Overflow.Hidden
const ABSOLUTE = 1;
const HIDDEN = 1;
const TOP_LEFT = -0.5;
const TEXEL_BIAS = 0.05;

const STRIP_PROPS = 3;
const SPRITE_PROPS = 7;

export class SceneRenderer {
  readonly columns: number;
  readonly slots: number;
  private readonly stripW: number;
  private readonly viewH: number;
  private readonly batch: JumpBatch;
  private readonly spriteBase: number;
  private readonly stripsRoot: NodeMirror;
  private readonly spritesRoot: NodeMirror;
  private readonly parent: NodeMirror;

  constructor(parent: NodeMirror, viewW: number, viewH: number, stripW: number, slots: number) {
    this.parent = parent;
    this.stripW = stripW;
    this.viewH = viewH;
    this.columns = Math.ceil(viewW / stripW);
    this.slots = slots;
    const entries: (readonly [NodeMirror, "scaleX" | "scaleY" | "translateX" | "translateY"])[] = [];

    this.stripsRoot = createElement("view");
    setProp(this.stripsRoot, "style", { posType: ABSOLUTE, insetL: 0, insetT: 0, width: viewW, height: viewH });
    insertNode(parent, this.stripsRoot);
    for (let i = 0; i < this.columns; i++) {
      const strip = createElement("view");
      setProp(strip, "style", {
        posType: ABSOLUTE, insetL: i * stripW, insetT: 0, width: stripW, height: viewH, overflow: HIDDEN,
      });
      const img = createElement("image");
      setProp(img, "style", {
        posType: ABSOLUTE, insetL: 0, insetT: 0, width: ATLAS_SIZE, height: ATLAS_SIZE,
        originX: TOP_LEFT, originY: TOP_LEFT, scaleX: stripW, scaleY: 0,
      });
      setProp(img, "src", WALL_ATLAS);
      insertNode(strip, img);
      insertNode(this.stripsRoot, strip);
      entries.push([img, "scaleY"], [img, "translateX"], [img, "translateY"]);
    }

    this.spriteBase = entries.length;
    this.spritesRoot = createElement("view");
    setProp(this.spritesRoot, "style", { posType: ABSOLUTE, insetL: 0, insetT: 0, width: viewW, height: viewH, overflow: HIDDEN });
    insertNode(parent, this.spritesRoot);
    for (let i = 0; i < slots; i++) {
      const wrap = createElement("view");
      setProp(wrap, "style", {
        posType: ABSOLUTE, insetL: 0, insetT: 0, width: CELL_SIZE, height: CELL_SIZE, overflow: HIDDEN,
        originX: TOP_LEFT, originY: TOP_LEFT, scaleX: 0, scaleY: 0,
      });
      const img = createElement("image");
      setProp(img, "style", {
        posType: ABSOLUTE, insetL: 0, insetT: 0, width: ATLAS_SIZE, height: ATLAS_SIZE,
        originX: TOP_LEFT, originY: TOP_LEFT,
      });
      setProp(img, "src", SPRITE_ATLAS);
      insertNode(wrap, img);
      insertNode(this.spritesRoot, wrap);
      entries.push(
        [wrap, "translateX"], [wrap, "translateY"], [wrap, "scaleX"], [wrap, "scaleY"],
        [img, "scaleX"], [img, "translateX"], [img, "translateY"],
      );
    }
    this.batch = createJumpBatch(entries);
  }

  /** One wall column: `wallH` projected pixels of atlas `cell`, texture column `texU`. */
  writeStrip(i: number, wallH: number, cell: number, texU: number): void {
    const base = i * STRIP_PROPS;
    const b = this.batch;
    if (wallH <= 0) {
      b.set(base, 0);
      return;
    }
    const cx = cell % ATLAS_COLS;
    const cy = (cell - cx) / ATLAS_COLS;
    const scaleY = wallH / CELL_SIZE;
    b.set(base, scaleY);
    b.set(base + 1, -(cx * CELL_SIZE + texU + TEXEL_BIAS) * this.stripW);
    b.set(base + 2, (this.viewH - wallH) * 0.5 - (cy * CELL_SIZE + TEXEL_BIAS) * scaleY);
  }

  /** One sprite: screen box (left, top, size), visible run [a, b), atlas `cell`. */
  writeSprite(slot: number, cell: number, left: number, top: number, size: number, a: number, b: number): void {
    const base = this.spriteBase + slot * SPRITE_PROPS;
    const bt = this.batch;
    const run = b - a;
    if (run <= 0 || size <= 0) {
      bt.set(base + 2, 0);
      bt.set(base + 3, 0);
      return;
    }
    const cx = cell % ATLAS_COLS;
    const cy = (cell - cx) / ATLAS_COLS;
    bt.set(base, a);
    bt.set(base + 1, top);
    bt.set(base + 2, run / CELL_SIZE);
    bt.set(base + 3, size / CELL_SIZE);
    const childScale = size / run;
    bt.set(base + 4, childScale);
    bt.set(base + 5, ((left - a) * CELL_SIZE - (cx * CELL_SIZE + TEXEL_BIAS) * size) / run);
    bt.set(base + 6, -(cy * CELL_SIZE + TEXEL_BIAS));
  }

  hideSprite(slot: number): void {
    const base = this.spriteBase + slot * SPRITE_PROPS;
    this.batch.set(base + 2, 0);
    this.batch.set(base + 3, 0);
  }

  commit(): void {
    this.batch.commit();
  }

  dispose(): void {
    detachNode(this.parent, this.stripsRoot);
    detachNode(this.parent, this.spritesRoot);
  }
}
