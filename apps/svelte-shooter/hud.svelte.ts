// apps/svelte-shooter/hud.svelte.ts — what the HUD shows, wherever it is mounted.
//
// One module-level rune store so the side panel (PSP, web) and the bottom
// screen (3DS) read the same values, and one plain `refs` bag for the two
// nodes the frame loop writes directly (score text, boss health bar) without
// a Svelte commit. The presenter only writes a field when it changed, so a
// quiet frame costs the HUD nothing.

import type { NodeMirror } from "@pocketjs/framework/svelte/components";
import type { Game } from "./game/state.ts";

export const hud = $state({
  lives: 3,
  bombs: 3,
  lock: false,
  mode: 0,
  boss: false,
  phase: 0,
});

export const refs: { score?: NodeMirror; bossBar?: NodeMirror } = {};

export function syncHud(g: Game): void {
  if (hud.lives !== g.lives) hud.lives = g.lives;
  if (hud.bombs !== g.bombs) hud.bombs = g.bombs;
  if (hud.lock !== g.lock) hud.lock = g.lock;
  if (hud.mode !== g.mode) hud.mode = g.mode;
  if (hud.boss !== g.boss.alive) hud.boss = g.boss.alive;
  if (hud.phase !== g.boss.phase) hud.phase = g.boss.phase;
}
