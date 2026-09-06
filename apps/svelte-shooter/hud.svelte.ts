// apps/svelte-shooter/hud.svelte.ts — what the HUD shows, wherever it is mounted.
//
// One module-level rune store so the side panel (PSP, web) and the bottom
// screen (3DS) read the same values, and one plain `refs` bag for the nodes
// the frame loop writes directly (the score digits, the boss health bar)
// without a Svelte commit. The presenter only writes a field when it
// changed, so a quiet frame costs the HUD nothing.
//
// The score is seven image nodes, not a text node: replacing a text run
// re-lays out the whole tree in the core (about 2 ms on the PSP, every time
// the score moved), while pointing an image at another baked digit is a
// paint-only write.

import type { NodeMirror } from "@pocketjs/framework/svelte/components";
import { setProp } from "@pocketjs/framework/svelte/renderer";
import type { Game } from "./game/state.ts";

export const SCORE_DIGITS = 7;
/** Baked by apps/svelte-shooter/gen-assets.ts from Kenney's numerals. */
const DIGIT_SRC = [
  "art/n0.png",
  "art/n1.png",
  "art/n2.png",
  "art/n3.png",
  "art/n4.png",
  "art/n5.png",
  "art/n6.png",
  "art/n7.png",
  "art/n8.png",
  "art/n9.png",
];
/** The digit each score node currently shows; every node mounts on n0. */
const shownDigit = new Uint8Array(SCORE_DIGITS);

export const hud = $state({
  lives: 3,
  bombs: 3,
  lock: false,
  mode: 0,
  boss: false,
  phase: 0,
});

export const refs: { digits: (NodeMirror | undefined)[]; bossBar?: NodeMirror } = {
  digits: new Array(SCORE_DIGITS),
};

/** Re-point only the digit nodes whose value changed; nothing else moves. */
export function updateScore(score: number): void {
  let rest = score;
  for (let i = SCORE_DIGITS - 1; i >= 0; i--) {
    const d = rest % 10;
    rest = (rest - d) / 10;
    const node = refs.digits[i];
    if (node && shownDigit[i] !== d) {
      shownDigit[i] = d;
      setProp(node, "src", DIGIT_SRC[d]);
    }
  }
}

export function syncHud(g: Game): void {
  if (hud.lives !== g.lives) hud.lives = g.lives;
  if (hud.bombs !== g.bombs) hud.bombs = g.bombs;
  if (hud.lock !== g.lock) hud.lock = g.lock;
  if (hud.mode !== g.mode) hud.mode = g.mode;
  if (hud.boss !== g.boss.alive) hud.boss = g.boss.alive;
  if (hud.phase !== g.boss.phase) hud.phase = g.boss.phase;
}
