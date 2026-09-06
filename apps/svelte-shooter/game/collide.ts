// apps/svelte-shooter/game/collide.ts — the frame's contact tests.
//
// Shots against enemy boxes, then everything hostile against the player's
// core. At most 24 x 16 box tests plus one circle test per live enemy bullet.

import {
  BOSS_R,
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

export function collide(g: Game): void {
  const pb = g.pb;
  const en = g.en;
  const eb = g.eb;
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

  if (g.pDead > 0) return;
  const px = g.px;
  const py = g.py;
  const safe = g.pInvuln > 0;

  for (let i = 0; i < eb.n; i++) {
    if (!eb.alive[i]) continue;
    const dx = eb.x[i] - px;
    const dy = eb.y[i] - py;
    const d2 = dx * dx + dy * dy;
    const rr = eb.r[i] + PLAYER_R;
    if (!safe && d2 < rr * rr) {
      playerHit(g);
      return; // the hit cleared every bullet
    }
    if (!eb.grazed[i]) {
      const gr = eb.r[i] + GRAZE_R;
      if (d2 < gr * gr) {
        eb.grazed[i] = 1;
        g.graze++;
        g.score += GRAZE_SCORE;
        g.events |= EV_GRAZE | EV_HUD;
      }
    }
  }

  if (safe) return;
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
