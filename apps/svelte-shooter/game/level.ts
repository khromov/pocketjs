// apps/svelte-shooter/game/level.ts — the one level, as a table.
//
// A wave spawns `count` enemies `gap` ticks apart from tick `at`. x0/dx are
// authored for a 288 px field (FIELD_REF_W) and scaled to the real width, so
// the 400 px 3DS field runs the same script. `at` is compared with >= so a
// host stepping several ticks per frame never skips a wave.

import { FIELD_REF_W, TYPE_DRONE, TYPE_GUNSHIP, TYPE_HEAVY } from "./constants.ts";
import { spawnBoss } from "./boss.ts";
import {
  PAT_AIMED,
  PAT_FAN3,
  PAT_FAN5,
  PAT_RING12,
  PAT_RING16,
  PAT_SPIRAL2,
  sendEnemiesAway,
} from "./enemies.ts";
import { PATH_DIVE, PATH_HOLD, PATH_SWEEP_L, PATH_SWEEP_R, PATH_ZIGZAG } from "./paths.ts";
import { spawnEnemy } from "./pools.ts";
import type { Game } from "./state.ts";

export interface Wave {
  at: number;
  type: number;
  path: number;
  pattern: number;
  count: number;
  gap: number;
  x0: number;
  dx: number;
  hp: number;
  /** Ticks on screen before the first volley (each later enemy waits 6 more). */
  cd0: number;
}

export const WAVES: readonly Wave[] = [
  { at: 60, type: TYPE_DRONE, path: PATH_DIVE, pattern: PAT_AIMED, count: 3, gap: 20, x0: 144, dx: 0, hp: 6, cd0: 40 },
  { at: 300, type: TYPE_DRONE, path: PATH_SWEEP_L, pattern: PAT_AIMED, count: 4, gap: 18, x0: 0, dx: 0, hp: 6, cd0: 40 },
  { at: 480, type: TYPE_DRONE, path: PATH_SWEEP_R, pattern: PAT_AIMED, count: 4, gap: 18, x0: 0, dx: 0, hp: 6, cd0: 40 },
  { at: 720, type: TYPE_GUNSHIP, path: PATH_HOLD, pattern: PAT_FAN3, count: 1, gap: 0, x0: 72, dx: 0, hp: 24, cd0: 60 },
  { at: 720, type: TYPE_GUNSHIP, path: PATH_HOLD, pattern: PAT_FAN3, count: 1, gap: 0, x0: 216, dx: 0, hp: 24, cd0: 80 },
  { at: 960, type: TYPE_DRONE, path: PATH_DIVE, pattern: PAT_AIMED, count: 5, gap: 15, x0: 48, dx: 48, hp: 6, cd0: 30 },
  { at: 1200, type: TYPE_HEAVY, path: PATH_HOLD, pattern: PAT_RING16, count: 1, gap: 0, x0: 144, dx: 0, hp: 60, cd0: 50 },
  { at: 1500, type: TYPE_GUNSHIP, path: PATH_SWEEP_L, pattern: PAT_FAN5, count: 2, gap: 60, x0: 0, dx: 0, hp: 24, cd0: 45 },
  { at: 1800, type: TYPE_DRONE, path: PATH_ZIGZAG, pattern: PAT_AIMED, count: 6, gap: 20, x0: 72, dx: 30, hp: 8, cd0: 30 },
  { at: 2100, type: TYPE_HEAVY, path: PATH_HOLD, pattern: PAT_RING12, count: 1, gap: 0, x0: 72, dx: 0, hp: 60, cd0: 40 },
  { at: 2100, type: TYPE_HEAVY, path: PATH_HOLD, pattern: PAT_SPIRAL2, count: 1, gap: 0, x0: 216, dx: 0, hp: 60, cd0: 40 },
  { at: 2520, type: TYPE_DRONE, path: PATH_DIVE, pattern: PAT_AIMED, count: 8, gap: 12, x0: 40, dx: 30, hp: 8, cd0: 25 },
  { at: 2880, type: TYPE_GUNSHIP, path: PATH_HOLD, pattern: PAT_FAN5, count: 3, gap: 30, x0: 96, dx: 48, hp: 30, cd0: 40 },
  { at: 3240, type: TYPE_DRONE, path: PATH_ZIGZAG, pattern: PAT_AIMED, count: 6, gap: 15, x0: 60, dx: 34, hp: 8, cd0: 20 },
];

/** 64 s: the boss arrives and whoever is left leaves. */
export const BOSS_AT = 3840;

function spawnWaveEnemy(g: Game, w: Wave, k: number): void {
  const sx = g.w / FIELD_REF_W;
  let x = (w.x0 + k * w.dx) * sx;
  let y = -20;
  if (w.path === PATH_SWEEP_L) {
    x = -24;
    y = 44 + k * 10;
  } else if (w.path === PATH_SWEEP_R) {
    x = g.w + 24;
    y = 44 + k * 10;
  }
  spawnEnemy(g.en, w.type, x, y, w.path, w.pattern, w.hp, w.cd0 + k * 6);
}

export function advanceLevel(g: Game): void {
  while (g.waveIdx < WAVES.length) {
    const w = WAVES[g.waveIdx];
    if (g.t < w.at + g.waveK * w.gap) break;
    spawnWaveEnemy(g, w, g.waveK);
    g.waveK++;
    if (g.waveK >= w.count) {
      g.waveIdx++;
      g.waveK = 0;
    }
  }
  if (!g.boss.spawned && g.t >= BOSS_AT) {
    sendEnemiesAway(g);
    spawnBoss(g);
  }
}
