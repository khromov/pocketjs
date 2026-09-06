// apps/svelte-shooter/present.ts — game state -> pooled host nodes, once per frame.
//
// Every pooled sprite is an absolutely positioned node parked at the
// playfield origin with its centre on (0, 0); the presenter moves it with
// translateX/translateY and shows it with opacity — paint-only props, so a
// few hundred bullets a frame never touch layout. The writes go into one
// record buffer (framework/src/anim.ts createPropBatchWriter) straight from
// the loops, and only live slots and transitions produce records: a dead
// slot costs nothing on either side of the host boundary.
//
// Bursts and the bomb flash are stepped here too, as records, rather than
// through animate(): while an animation track is alive the core scans the
// track table on every property write, and this frame writes hundreds.

import { createPropBatchWriter } from "@pocketjs/framework/svelte/animation";
import type { NodeMirror } from "@pocketjs/framework/svelte/components";
import { setProp } from "@pocketjs/framework/svelte/renderer";
import { MAX_FX } from "./game/constants.ts";
import type { BulletPool, EnemyPool } from "./game/pools.ts";
import type { Game } from "./game/state.ts";

/** Texture per bullet kind; a slot's node is re-pointed when its kind changes. */
const KIND_SRC = ["art/bullet-red.png", "art/bullet-blue.png", "art/bullet-green.png"];
const FX_TICKS = 16;
const FX_SCALE_FROM = 0.3;
const FX_SCALE_TO = 2.2;
const FLASH_TICKS = 24;
const FLASH_PEAK = 0.85;

export interface PresenterNodes {
  eb: readonly (NodeMirror | undefined)[];
  pb: readonly (NodeMirror | undefined)[];
  en: readonly (NodeMirror | undefined)[];
  fx: readonly (NodeMirror | undefined)[];
  boss: NodeMirror | undefined;
  player: NodeMirror | undefined;
  shield: NodeMirror | undefined;
  flash: NodeMirror | undefined;
  bgA: NodeMirror | undefined;
  bgB: NodeMirror | undefined;
}

export interface Presenter {
  /** Write this frame's positions, visibility and effects, then commit. */
  present(g: Game, scroll: number, tile: number): void;
  /** Hide every pooled sprite and cancel the effects (a restart). */
  hideAll(): void;
  /** Start a burst ring at (x, y): it grows and fades over FX_TICKS. */
  burst(x: number, y: number): void;
  /** The bomb's white flash. */
  flash(): void;
}

function need(node: NodeMirror | undefined, what: string): NodeMirror {
  if (!node) throw new Error(`svelte-shooter: ${what} was not mounted before the presenter was built`);
  return node;
}

function ids(nodes: readonly (NodeMirror | undefined)[], what: string): Int32Array {
  const out = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) out[i] = need(nodes[i], `${what} ${i}`).id;
  return out;
}

export function buildPresenter(nodes: PresenterNodes): Presenter {
  const ebNodes = nodes.eb.map((n, i) => need(n, `enemy bullet ${i}`));
  const ebId = ids(nodes.eb, "enemy bullet");
  const pbId = ids(nodes.pb, "shot");
  const enId = ids(nodes.en, "enemy");
  const fxId = ids(nodes.fx, "burst");
  const bossId = need(nodes.boss, "boss").id;
  const playerId = need(nodes.player, "player").id;
  const shieldId = need(nodes.shield, "shield").id;
  const flashId = need(nodes.flash, "flash").id;
  const bgAId = need(nodes.bgA, "background A").id;
  const bgBId = need(nodes.bgB, "background B").id;

  // Worst case: every slot live and every transition in one frame.
  const capacity =
    (ebId.length + pbId.length + enId.length) * 3 + 3 + 3 + 1 + 1 + 2 + fxId.length * 4 + 2;
  const writer = createPropBatchWriter(capacity);
  const R = writer.records;
  const TX = writer.propId("translateX");
  const TY = writer.propId("translateY");
  const OP = writer.propId("opacity");
  const SC = writer.propId("scale");

  const ebShown = new Uint8Array(ebId.length);
  /** The kind whose texture each bullet node currently shows (0 at mount). */
  const ebKind = new Uint8Array(ebId.length);
  const pbShown = new Uint8Array(pbId.length);
  const enShown = new Uint8Array(enId.length);
  let bossShown = 0;
  let playerOp = -1;
  let shieldOp = -1;
  let bgScroll = -1;

  const fxT = new Float32Array(MAX_FX);
  const fxX = new Float32Array(MAX_FX);
  const fxY = new Float32Array(MAX_FX);
  const fxFresh = new Uint8Array(MAX_FX);
  let fxNext = 0;
  let flashT = 0;

  /** Record count for the frame being written. */
  let count = 0;

  function put(id: number, prop: number, value: number): void {
    const k = count * 3;
    R[k] = id;
    R[k + 1] = prop;
    R[k + 2] = value;
    count++;
  }

  /** Positions for live slots, opacity only when a slot appears or vanishes. */
  function pool(p: BulletPool | EnemyPool, id: Int32Array, shown: Uint8Array): void {
    let k = count * 3;
    for (let i = 0; i < p.n; i++) {
      if (p.alive[i]) {
        const nid = id[i];
        R[k] = nid;
        R[k + 1] = TX;
        R[k + 2] = p.x[i];
        R[k + 3] = nid;
        R[k + 4] = TY;
        R[k + 5] = p.y[i];
        k += 6;
        if (!shown[i]) {
          shown[i] = 1;
          R[k] = nid;
          R[k + 1] = OP;
          R[k + 2] = 1;
          k += 3;
        }
      } else if (shown[i]) {
        shown[i] = 0;
        R[k] = id[i];
        R[k + 1] = OP;
        R[k + 2] = 0;
        k += 3;
      }
    }
    count = k / 3;
  }

  /** As pool(), plus the texture swap when a slot's kind changed since it last showed. */
  function bullets(p: BulletPool): void {
    const n = p.n;
    const alive = p.alive;
    const X = p.x;
    const Y = p.y;
    let k = count * 3;
    for (let i = 0; i < n; i++) {
      if (alive[i]) {
        const nid = ebId[i];
        R[k] = nid;
        R[k + 1] = TX;
        R[k + 2] = X[i];
        R[k + 3] = nid;
        R[k + 4] = TY;
        R[k + 5] = Y[i];
        k += 6;
        if (!ebShown[i]) {
          ebShown[i] = 1;
          const kind = p.kind[i];
          if (ebKind[i] !== kind) {
            ebKind[i] = kind;
            setProp(ebNodes[i], "src", KIND_SRC[kind]);
          }
          R[k] = nid;
          R[k + 1] = OP;
          R[k + 2] = 1;
          k += 3;
        }
      } else if (ebShown[i]) {
        ebShown[i] = 0;
        R[k] = ebId[i];
        R[k + 1] = OP;
        R[k + 2] = 0;
        k += 3;
      }
    }
    count = k / 3;
  }

  function effects(dt: number): void {
    for (let i = 0; i < MAX_FX; i++) {
      const t = fxT[i];
      if (t <= 0) continue;
      const id = fxId[i];
      if (fxFresh[i]) {
        fxFresh[i] = 0;
        put(id, TX, fxX[i]);
        put(id, TY, fxY[i]);
      }
      const u = 1 - t / FX_TICKS;
      put(id, SC, FX_SCALE_FROM + (FX_SCALE_TO - FX_SCALE_FROM) * u);
      const next = t - dt;
      fxT[i] = next;
      put(id, OP, next > 0 ? 1 - u : 0);
    }
    if (flashT > 0) {
      const next = flashT - dt;
      flashT = next;
      put(flashId, OP, next > 0 ? FLASH_PEAK * (next / FLASH_TICKS) : 0);
    }
  }

  return {
    present(g, scroll, tile) {
      count = 0;
      bullets(g.eb);
      pool(g.pb, pbId, pbShown);
      pool(g.en, enId, enShown);

      const b = g.boss;
      if (b.alive) {
        put(bossId, TX, b.x);
        put(bossId, TY, b.y);
        // A short flicker marks the phase-change invulnerability.
        const op = b.invuln > 0 && ((b.phaseT / 3) | 0) & 1 ? 0.55 : 1;
        if (bossShown !== op) {
          bossShown = op;
          put(bossId, OP, op);
        }
      } else if (bossShown !== 0) {
        bossShown = 0;
        put(bossId, OP, 0);
      }

      put(playerId, TX, g.px);
      put(playerId, TY, g.py);
      let pOp = 0;
      let sOp = 0;
      if (g.pDead <= 0) {
        pOp = g.pInvuln > 0 ? (((g.t / 4) | 0) & 1 ? 0.45 : 1) : 1;
        sOp = g.pInvuln > 0 ? 0.75 : 0;
      }
      if (pOp !== playerOp) {
        playerOp = pOp;
        put(playerId, OP, pOp);
      }
      if (sOp !== shieldOp) {
        shieldOp = sOp;
        put(shieldId, OP, sOp);
      }

      if (scroll !== bgScroll) {
        bgScroll = scroll;
        put(bgAId, TY, scroll);
        put(bgBId, TY, scroll - tile);
      }

      effects(g.dt);
      writer.commit(count);
      count = 0;
    },

    hideAll() {
      count = 0;
      for (let i = 0; i < ebId.length; i++) {
        if (ebShown[i]) {
          ebShown[i] = 0;
          put(ebId[i], OP, 0);
        }
      }
      for (let i = 0; i < pbId.length; i++) {
        if (pbShown[i]) {
          pbShown[i] = 0;
          put(pbId[i], OP, 0);
        }
      }
      for (let i = 0; i < enId.length; i++) {
        if (enShown[i]) {
          enShown[i] = 0;
          put(enId[i], OP, 0);
        }
      }
      for (let i = 0; i < MAX_FX; i++) {
        if (fxT[i] > 0) {
          fxT[i] = 0;
          put(fxId[i], OP, 0);
        }
      }
      if (flashT > 0) {
        flashT = 0;
        put(flashId, OP, 0);
      }
      bossShown = 0;
      put(bossId, OP, 0);
      writer.commit(count);
      count = 0;
    },

    burst(x, y) {
      const i = fxNext;
      fxNext = (fxNext + 1) % MAX_FX;
      fxT[i] = FX_TICKS;
      fxX[i] = x;
      fxY[i] = y;
      fxFresh[i] = 1;
    },

    flash() {
      flashT = FLASH_TICKS;
    },
  };
}
