// apps/svelte-shooter/game/collide.ts — the frame's contact tests.
//
// Shots against enemy boxes, then everything hostile against the player's
// core. Enemy bullets move, cull and test in ONE pass over the pool
// (stepEnemyBullets): with a few hundred live bullets a second sweep is a
// measurable share of the PSP's frame.

import {
  BOSS_R,
  CULL_MARGIN,
  EV_GRAZE,
  EV_HIT,
  EV_HUD,
  GRAZE_R,
  GRAZE_SCORE,
  PB_DAMAGE,
  PB_HALF_H,
  PB_HALF_W,
  PLAYER_R,
} from "./constants.ts";
import { damageBoss } from "./boss.ts";
import { damageEnemy } from "./enemies.ts";
import { playerHit } from "./player.ts";
import { killBullet } from "./pools.ts";
import type { Game } from "./state.ts";

/** Move every enemy bullet, drop the ones off the field, and test the rest
 *  against the player's core and graze ring. A hit is applied after the pass
 *  (it clears the pool), so the loop never mutates what it iterates. */
export function stepEnemyBullets(g: Game, dt: number): void {
  const eb = g.eb;
  // Locals for the typed arrays: on QuickJS every `eb.x` is a property lookup.
  const n = eb.n;
  const alive = eb.alive;
  const X = eb.x;
  const Y = eb.y;
  const VX = eb.vx;
  const VY = eb.vy;
  const RAD = eb.r;
  const grazed = eb.grazed;
  const lo = -CULL_MARGIN;
  const hiX = g.w + CULL_MARGIN;
  const hiY = g.h + CULL_MARGIN;
  const px = g.px;
  const py = g.py;
  const canGraze = g.pDead <= 0;
  const canHit = canGraze && g.pInvuln <= 0;
  let hit = false;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const x = (X[i] += VX[i] * dt);
    const y = (Y[i] += VY[i] * dt);
    if (x < lo || x > hiX || y < lo || y > hiY) {
      killBullet(eb, i);
      continue;
    }
    if (hit || !canGraze) continue;
    const dx = x - px;
    const dy = y - py;
    const d2 = dx * dx + dy * dy;
    const r = RAD[i];
    if (canHit) {
      const rr = r + PLAYER_R;
      if (d2 < rr * rr) {
        hit = true;
        continue;
      }
    }
    if (!grazed[i]) {
      const gr = r + GRAZE_R;
      if (d2 < gr * gr) {
        grazed[i] = 1;
        g.graze++;
        g.score += GRAZE_SCORE;
        g.events |= EV_GRAZE | EV_HUD;
      }
    }
  }
  if (hit) playerHit(g);
}

export function collide(g: Game): void {
  const pb = g.pb;
  const en = g.en;
  const b = g.boss;

  for (let i = 0; i < pb.n; i++) {
    if (!pb.alive[i]) continue;
    const x = pb.x[i];
    const y = pb.y[i];
    let hit = false;
    for (let j = 0; j < en.n; j++) {
      if (!en.alive[j] || en.y[j] < -8) continue;
      const r = en.r[j];
      if (Math.abs(en.x[j] - x) < r + PB_HALF_W && Math.abs(en.y[j] - y) < r + PB_HALF_H) {
        damageEnemy(g, j, PB_DAMAGE);
        hit = true;
        break;
      }
    }
    if (!hit && b.alive && !b.entering) {
      if (Math.abs(b.x - x) < BOSS_R + PB_HALF_W && Math.abs(b.y - y) < BOSS_R + PB_HALF_H) {
        damageBoss(g, PB_DAMAGE);
        hit = true;
      }
    }
    if (hit) {
      killBullet(pb, i);
      g.events |= EV_HIT;
    }
  }

  if (g.pDead > 0 || g.pInvuln > 0) return;
  const px = g.px;
  const py = g.py;
  for (let j = 0; j < en.n; j++) {
    if (!en.alive[j]) continue;
    const dx = en.x[j] - px;
    const dy = en.y[j] - py;
    const rr = en.r[j] + PLAYER_R;
    if (dx * dx + dy * dy < rr * rr) {
      playerHit(g);
      return;
    }
  }
  if (b.alive && !b.entering) {
    const dx = b.x - px;
    const dy = b.y - py;
    const rr = BOSS_R + PLAYER_R;
    if (dx * dx + dy * dy < rr * rr) playerHit(g);
  }
}
