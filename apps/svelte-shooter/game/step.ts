// apps/svelte-shooter/game/step.ts — one simulation step.
//
// Order: player, level script, enemies, boss, shots, enemy bullets (moved and
// tested in one pass), then shots and bodies against their targets. Every
// mutation the presenter cares about lands in `g.events`.

import { CULL_MARGIN, EV_BOSS_HP, EV_HUD, EV_MODE, MODE_PAUSE, MODE_PLAY } from "./constants.ts";
import { updateBoss } from "./boss.ts";
import { collide, stepEnemyBullets } from "./collide.ts";
import { stepEnemies } from "./enemies.ts";
import { advanceLevel } from "./level.ts";
import { stepPlayer, type Input } from "./player.ts";
import { killBullet, type BulletPool } from "./pools.ts";
import { resetGame, type Game } from "./state.ts";

export type { Input } from "./player.ts";
export { useBomb } from "./player.ts";

/** The player's shots: straight up, gone past the top edge. */
function stepShots(p: BulletPool, dt: number, w: number, h: number): void {
  for (let i = 0; i < p.n; i++) {
    if (!p.alive[i]) continue;
    const x = (p.x[i] += p.vx[i] * dt);
    const y = (p.y[i] += p.vy[i] * dt);
    if (x < -CULL_MARGIN || x > w + CULL_MARGIN || y < -CULL_MARGIN || y > h + CULL_MARGIN) {
      killBullet(p, i);
    }
  }
}

export function stepGame(g: Game, inp: Input): void {
  if (g.mode !== MODE_PLAY) return;
  const dt = g.dt;
  g.t += dt;
  stepPlayer(g, inp, dt);
  advanceLevel(g);
  stepEnemies(g, dt);
  updateBoss(g, dt);
  stepShots(g.pb, dt, g.w, g.h);
  stepEnemyBullets(g, dt);
  collide(g);
}

/** START while playing or paused. Other modes ignore it (restart() owns those). */
export function togglePause(g: Game): void {
  if (g.mode === MODE_PLAY) g.mode = MODE_PAUSE;
  else if (g.mode === MODE_PAUSE) g.mode = MODE_PLAY;
  else return;
  g.events |= EV_MODE;
}

export function restart(g: Game): void {
  resetGame(g);
  g.events |= EV_HUD | EV_MODE | EV_BOSS_HP;
}
