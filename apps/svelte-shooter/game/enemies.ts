// apps/svelte-shooter/game/enemies.ts — wave enemies: movement, firing, damage.

import {
  CULL_MARGIN,
  EV_HUD,
  EV_KILL,
  KIND_BLUE,
  KIND_GREEN,
  KIND_RED,
  TYPE_SCORE,
} from "./constants.ts";
import { PATH_EXIT, stepEnemyMove } from "./paths.ts";
import { angleTo, fireFan, fireRing, fireSpiral } from "./patterns.ts";
import { killEnemy } from "./pools.ts";
import { pushFx, type Game } from "./state.ts";

export const PAT_AIMED = 0;
export const PAT_FAN3 = 1;
export const PAT_FAN5 = 2;
export const PAT_RING12 = 3;
export const PAT_RING16 = 4;
export const PAT_SPIRAL2 = 5;

/** One volley of the slot's pattern; sets the cooldown to the next one. */
function fireEnemyPattern(g: Game, i: number): void {
  const en = g.en;
  const x = en.x[i];
  const y = en.y[i];
  const eb = g.eb;
  switch (en.pattern[i]) {
    case PAT_AIMED:
      fireFan(eb, x, y, angleTo(x, y, g.px, g.py), 3, 0.28, 1.15, KIND_RED);
      en.fireCd[i] = 50;
      break;
    case PAT_FAN3:
      fireFan(eb, x, y, angleTo(x, y, g.px, g.py), 5, 0.55, 1.1, KIND_RED);
      en.fireCd[i] = 40;
      break;
    case PAT_FAN5:
      fireFan(eb, x, y, angleTo(x, y, g.px, g.py), 9, 1.3, 1.2, KIND_RED);
      en.fireCd[i] = 36;
      break;
    case PAT_RING12:
      en.phase[i] += 0.2;
      fireRing(eb, x, y, 24, 0.9, en.phase[i], KIND_BLUE);
      en.fireCd[i] = 45;
      break;
    case PAT_RING16:
      en.phase[i] += 0.15;
      fireRing(eb, x, y, 32, 0.85, en.phase[i], KIND_BLUE);
      en.fireCd[i] = 50;
      break;
    case PAT_SPIRAL2:
      en.phase[i] += 0.13;
      fireSpiral(eb, x, y, en.phase[i], 3, 1.1, KIND_GREEN);
      en.fireCd[i] = 3;
      break;
  }
}

export function stepEnemies(g: Game, dt: number): void {
  const en = g.en;
  const w = g.w;
  const h = g.h;
  for (let i = 0; i < en.n; i++) {
    if (!en.alive[i]) continue;
    en.age[i] += dt;
    stepEnemyMove(en, i, dt);
    const x = en.x[i];
    const y = en.y[i];
    // Off the bottom or sides, or back out the top after having been seen.
    if (
      y > h + CULL_MARGIN ||
      x < -40 ||
      x > w + 40 ||
      (y < -CULL_MARGIN - 24 && en.age[i] > 30)
    ) {
      killEnemy(en, i);
      continue;
    }
    if (en.path[i] === PATH_EXIT) continue;
    // Fire only once on screen: a volley from above the top edge is unfair.
    if (y < 4) continue;
    en.fireCd[i] -= dt;
    if (en.fireCd[i] <= 0) fireEnemyPattern(g, i);
  }
}

export function damageEnemy(g: Game, i: number, dmg: number): void {
  const en = g.en;
  if (!en.alive[i]) return;
  en.hp[i] -= dmg;
  if (en.hp[i] > 0) return;
  pushFx(g, en.x[i], en.y[i]);
  g.score += TYPE_SCORE[en.type[i]];
  killEnemy(en, i);
  g.events |= EV_KILL | EV_HUD;
}

/** Everyone still on screen leaves when the boss arrives. */
export function sendEnemiesAway(g: Game): void {
  const en = g.en;
  for (let i = 0; i < en.n; i++) if (en.alive[i]) en.path[i] = PATH_EXIT;
}
