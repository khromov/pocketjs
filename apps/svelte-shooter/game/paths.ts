// apps/svelte-shooter/game/paths.ts — enemy flight paths.
//
// Each path is a function of the slot's age (ticks since spawn) and its
// spawn point, so a 30 Hz host lands every enemy on the same pixel as a
// 60 Hz one.

import type { EnemyPool } from "./pools.ts";

export const PATH_DIVE = 0;
export const PATH_SWEEP_L = 1;
export const PATH_SWEEP_R = 2;
export const PATH_HOLD = 3;
export const PATH_ZIGZAG = 4;
export const PATH_EXIT = 5;

/** Where holders stop, and for how long, before leaving upward. */
export const HOLD_Y = 60;
export const HOLD_TICKS = 300;
const DESCENT = 1.5;

/** Triangle wave in [-1, 1] with period 1. */
function tri(p: number): number {
  const f = p - Math.floor(p);
  return 1 - 4 * Math.abs(f - 0.5);
}

export function stepEnemyMove(en: EnemyPool, i: number, dt: number): void {
  const age = en.age[i];
  switch (en.path[i]) {
    case PATH_DIVE:
      en.y[i] += 1.5 * dt;
      en.x[i] = en.x0[i] + Math.sin(age * 0.05) * 10;
      break;
    case PATH_SWEEP_L:
      en.x[i] += 1.6 * dt;
      en.y[i] = en.y0[i] + Math.sin(age * 0.04) * 24;
      break;
    case PATH_SWEEP_R:
      en.x[i] -= 1.6 * dt;
      en.y[i] = en.y0[i] + Math.sin(age * 0.04) * 24;
      break;
    case PATH_HOLD: {
      const descend = (HOLD_Y - en.y0[i]) / DESCENT;
      if (age < descend) {
        en.y[i] = en.y0[i] + age * DESCENT;
      } else if (age < descend + HOLD_TICKS) {
        en.y[i] = HOLD_Y;
        en.x[i] = en.x0[i] + Math.sin((age - descend) * 0.03) * 12;
      } else {
        en.y[i] -= DESCENT * dt;
      }
      break;
    }
    case PATH_ZIGZAG:
      en.y[i] += 1.1 * dt;
      en.x[i] = en.x0[i] + tri(age * 0.004) * 40;
      break;
    case PATH_EXIT:
      en.y[i] -= 2 * dt;
      break;
  }
}
