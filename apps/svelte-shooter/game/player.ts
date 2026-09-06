// apps/svelte-shooter/game/player.ts — the ship: movement, fire, death, bombs.

import {
  BOMB_BOSS_DMG,
  BOMB_ENEMY_DMG,
  BOMB_INVULN,
  EV_BOMB,
  EV_HUD,
  EV_MODE,
  EV_PLAYER_HIT,
  EV_SHOT,
  FIRE_CD,
  FOCUS_SPEED,
  INVULN_TICKS,
  MODE_OVER,
  MODE_PLAY,
  PB_HALF_W,
  PB_SPEED,
  PLAYER_BOTTOM,
  PLAYER_MARGIN,
  PLAYER_SPEED,
  RESPAWN_TICKS,
} from "./constants.ts";
import { damageBoss } from "./boss.ts";
import { damageEnemy } from "./enemies.ts";
import { clearBullets, spawnBullet } from "./pools.ts";
import { pushFx, type Game } from "./state.ts";

export interface Input {
  /** -1..1 per axis, already normalised on the diagonal. */
  mx: number;
  my: number;
  fire: boolean;
  /** Hold to move slower; the same button as fire. */
  focus: boolean;
}

export function stepPlayer(g: Game, inp: Input, dt: number): void {
  if (g.pDead > 0) {
    g.pDead -= dt;
    if (g.pDead <= 0) {
      g.pDead = 0;
      g.px = g.w / 2;
      g.py = g.h - PLAYER_BOTTOM;
      g.pInvuln = INVULN_TICKS;
      g.pFireCd = 0;
    }
    return;
  }
  if (g.pInvuln > 0) {
    g.pInvuln -= dt;
    if (g.pInvuln < 0) g.pInvuln = 0;
  }
  g.focus = inp.focus;
  const speed = inp.focus ? FOCUS_SPEED : PLAYER_SPEED;
  let x = g.px + inp.mx * speed * dt;
  let y = g.py + inp.my * speed * dt;
  if (x < PLAYER_MARGIN) x = PLAYER_MARGIN;
  else if (x > g.w - PLAYER_MARGIN) x = g.w - PLAYER_MARGIN;
  if (y < PLAYER_MARGIN) y = PLAYER_MARGIN;
  else if (y > g.h - PLAYER_MARGIN) y = g.h - PLAYER_MARGIN;
  g.px = x;
  g.py = y;

  g.pFireCd -= dt;
  if ((inp.fire || g.lock) && g.pFireCd <= 0) {
    g.pFireCd = FIRE_CD;
    const spread = inp.focus ? 3 : 6;
    spawnBullet(g.pb, 0, x - spread, y - 10, 0, -PB_SPEED, PB_HALF_W);
    spawnBullet(g.pb, 0, x + spread, y - 10, 0, -PB_SPEED, PB_HALF_W);
    g.events |= EV_SHOT;
  }
}

export function playerHit(g: Game): void {
  g.lives--;
  clearBullets(g.eb);
  pushFx(g, g.px, g.py);
  g.pDead = RESPAWN_TICKS;
  g.pInvuln = 0;
  g.events |= EV_PLAYER_HIT | EV_HUD;
  if (g.lives <= 0) {
    g.lives = 0;
    g.mode = MODE_OVER;
    g.events |= EV_MODE;
  }
}

/** Clears every enemy bullet, hurts everything, and buys a moment of safety. */
export function useBomb(g: Game): boolean {
  if (g.mode !== MODE_PLAY || g.bombs <= 0 || g.pDead > 0) return false;
  g.bombs--;
  clearBullets(g.eb);
  const en = g.en;
  for (let i = 0; i < en.n; i++) if (en.alive[i] && en.y[i] > 0) damageEnemy(g, i, BOMB_ENEMY_DMG);
  damageBoss(g, BOMB_BOSS_DMG);
  if (g.pInvuln < BOMB_INVULN) g.pInvuln = BOMB_INVULN;
  g.events |= EV_BOMB | EV_HUD;
  return true;
}
