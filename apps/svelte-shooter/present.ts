// apps/svelte-shooter/present.ts — game state -> pooled host nodes, once per frame.
//
// Every pooled sprite is an absolutely positioned node parked at the
// playfield origin with its centre on (0, 0); the presenter moves it with
// translateX/translateY and shows it with opacity — paint-only props, so
// two hundred bullets a frame never touch layout. All writes go through one
// jump batch: one host call per frame on native hosts, per-property setProp
// on the rest (framework/src/anim.ts).

import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/svelte/animation";
import type { NodeMirror } from "@pocketjs/framework/svelte/components";
import type { BulletPool, EnemyPool } from "./game/pools.ts";
import type { Game } from "./game/state.ts";

type Entry = Parameters<typeof createJumpBatch>[0][number];

export interface PresenterNodes {
  eb: readonly (NodeMirror | undefined)[];
  pb: readonly (NodeMirror | undefined)[];
  en: readonly (NodeMirror | undefined)[];
  boss: NodeMirror | undefined;
  player: NodeMirror | undefined;
  shield: NodeMirror | undefined;
  bgA: NodeMirror | undefined;
  bgB: NodeMirror | undefined;
}

export interface Presenter {
  /** Write this frame's positions and visibility, then commit. */
  present(g: Game, scroll: number, tile: number): void;
  /** Hide every pooled sprite (a restart, before the first present). */
  hideAll(): void;
}

function need(node: NodeMirror | undefined, what: string): NodeMirror {
  if (!node) throw new Error(`svelte-shooter: ${what} was not mounted before the presenter was built`);
  return node;
}

export function buildPresenter(nodes: PresenterNodes): Presenter {
  const entries: Entry[] = [];
  const slot = (node: NodeMirror): void => {
    entries.push([node, "translateX"], [node, "translateY"], [node, "opacity"]);
  };
  const EB0 = entries.length;
  for (let i = 0; i < nodes.eb.length; i++) slot(need(nodes.eb[i], `enemy bullet ${i}`));
  const PB0 = entries.length;
  for (let i = 0; i < nodes.pb.length; i++) slot(need(nodes.pb[i], `shot ${i}`));
  const EN0 = entries.length;
  for (let i = 0; i < nodes.en.length; i++) slot(need(nodes.en[i], `enemy ${i}`));
  const BOSS0 = entries.length;
  slot(need(nodes.boss, "boss"));
  const PL0 = entries.length;
  slot(need(nodes.player, "player"));
  const SH0 = entries.length;
  entries.push([need(nodes.shield, "shield"), "opacity"]);
  const BG0 = entries.length;
  entries.push([need(nodes.bgA, "background A"), "translateY"], [need(nodes.bgB, "background B"), "translateY"]);
  const batch: JumpBatch = createJumpBatch(entries);
  const total = entries.length;
  // Batch records persist between commits, so a slot's opacity is written
  // only when it appears or vanishes: two writes per live sprite per frame.
  const shown = new Uint8Array(SH0 / 3);

  function pool(p: BulletPool | EnemyPool, base: number): void {
    for (let i = 0; i < p.n; i++) {
      const k = base + i * 3;
      const s = k / 3;
      if (p.alive[i]) {
        batch.set(k, p.x[i]);
        batch.set(k + 1, p.y[i]);
        if (!shown[s]) {
          shown[s] = 1;
          batch.set(k + 2, 1);
        }
      } else if (shown[s]) {
        shown[s] = 0;
        batch.set(k + 2, 0);
      }
    }
  }

  return {
    present(g, scroll, tile) {
      pool(g.eb, EB0);
      pool(g.pb, PB0);
      pool(g.en, EN0);

      const b = g.boss;
      if (b.alive) {
        batch.set(BOSS0, b.x);
        batch.set(BOSS0 + 1, b.y);
        // A short flicker marks the phase-change invulnerability.
        batch.set(BOSS0 + 2, b.invuln > 0 && ((b.phaseT / 3) | 0) & 1 ? 0.55 : 1);
      } else {
        batch.set(BOSS0 + 2, 0);
      }

      batch.set(PL0, g.px);
      batch.set(PL0 + 1, g.py);
      let playerOpacity = 0;
      let shieldOpacity = 0;
      if (g.pDead <= 0) {
        playerOpacity = g.pInvuln > 0 ? (((g.t / 4) | 0) & 1 ? 0.45 : 1) : 1;
        shieldOpacity = g.pInvuln > 0 ? 0.75 : 0;
      }
      batch.set(PL0 + 2, playerOpacity);
      batch.set(SH0, shieldOpacity);

      batch.set(BG0, scroll);
      batch.set(BG0 + 1, scroll - tile);
      batch.commit();
    },
    hideAll() {
      for (let k = 0; k < SH0; k += 3) batch.set(k + 2, 0);
      shown.fill(0);
      batch.set(SH0, 0);
      if (total !== BG0 + 2) throw new Error("svelte-shooter: presenter entry layout drifted");
      batch.commit();
    },
  };
}
