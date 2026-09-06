// apps/svelte-shooter/game/boss.ts — the four-phase boss.
//
// Every clock is `phaseT`, ticks since the phase began, read through due()
// so a host stepping two ticks per frame fires the same volleys. The phase
// bodies are switch arms rather than objects: nothing here allocates.

import {
  BOSS_ENTER_SPEED,
  BOSS_HP,
  BOSS_KILL_SCORE,
  BOSS_PHASE_INVULN,
  BOSS_PHASE_SCORE,
  BOSS_Y,
  EV_BOSS_ENTER,
  EV_BOSS_HP,
  EV_HUD,
  EV_KILL,
  EV_MODE,
  EV_PHASE,
  KIND_BLUE,
  KIND_GREEN,
  KIND_RED,
  MODE_CLEAR,
} from "./constants.ts";
import { TAU, angleTo, due, fireFan, fireRing, fireSpiral } from "./patterns.ts";
import { clearBullets } from "./pools.ts";
import { pushFx, type Game } from "./state.ts";

export function spawnBoss(g: Game): void {
  const b = g.boss;
  b.spawned = true;
  b.alive = true;
  b.entering = true;
  b.x = g.w / 2;
  b.y = -40;
  b.phase = 0;
  b.hp = BOSS_HP[0];
  b.maxHp = BOSS_HP[0];
  b.phaseT = 0;
  b.invuln = 0;
  b.angle = 0;
  b.angle2 = 0;
  b.targetX = g.w / 2;
  g.events |= EV_BOSS_ENTER | EV_BOSS_HP;
}

export function updateBoss(g: Game, dt: number): void {
  const b = g.boss;
  if (!b.alive) return;
  if (b.entering) {
    b.y += BOSS_ENTER_SPEED * dt;
    if (b.y >= BOSS_Y) {
      b.y = BOSS_Y;
      b.entering = false;
    }
    return;
  }
  b.phaseT += dt;
  if (b.invuln > 0) {
    b.invuln -= dt;
    if (b.invuln < 0) b.invuln = 0;
  }
  const t = b.phaseT;
  const cx = g.w / 2;
  /** Horizontal swing as a share of the field, so the 400 px 3DS field swings wider. */
  const amp = g.w * 0.2;
  const eb = g.eb;
  const armed = b.invuln === 0;

  switch (b.phase) {
    case 0:
      // Slow rings with aimed three-shots between them.
      b.x = cx + Math.sin(t * 0.02) * amp;
      b.y = BOSS_Y;
      if (!armed) break;
      if (due(t, dt, 40)) {
        b.angle += 0.15;
        fireRing(eb, b.x, b.y, 32, 0.9, b.angle, KIND_BLUE);
      }
      if (due(t, dt, 20, 10)) {
        fireFan(eb, b.x, b.y, angleTo(b.x, b.y, g.px, g.py), 5, 0.5, 1.4, KIND_RED);
      }
      break;
    case 1:
      // Twin spiral over a figure-eight, with a ring every 1.5 s.
      b.x = cx + Math.sin(t * 0.025) * amp;
      b.y = BOSS_Y + Math.sin(t * 0.05) * 14;
      if (!armed) break;
      if (due(t, dt, 4)) {
        b.angle += 0.12;
        fireSpiral(eb, b.x, b.y, b.angle, 4, 1.2, KIND_GREEN);
      }
      if (due(t, dt, 75)) {
        b.angle2 += 0.3;
        fireRing(eb, b.x, b.y, 28, 0.8, b.angle2, KIND_BLUE);
      }
      break;
    case 2:
      // Random-direction bursts, aimed fans, counter-rotating rings; lurches between targets.
      if (due(t, dt, 120)) b.targetX = g.rng.range(g.w * 0.2, g.w * 0.8);
      b.x += (b.targetX - b.x) * 0.03 * dt;
      b.y = BOSS_Y;
      if (!armed) break;
      if (due(t, dt, 45)) {
        fireFan(eb, b.x, b.y, g.rng.float() * TAU, 11, 1.6, 1.5, KIND_RED);
      }
      if (due(t, dt, 45, 15)) {
        fireFan(eb, b.x, b.y, angleTo(b.x, b.y, g.px, g.py), 7, 1.0, 1.1, KIND_RED);
      }
      if (due(t, dt, 90, 45)) {
        b.angle += 0.25;
        b.angle2 -= 0.25;
        fireRing(eb, b.x, b.y, 20, 0.85, b.angle, KIND_BLUE);
        fireRing(eb, b.x, b.y, 20, 0.85, b.angle2, KIND_GREEN);
      }
      break;
    default:
      // Finale: paired counter-rotating rings and a fast aimed pellet stream.
      b.x = cx + Math.sin(t * 0.03) * amp * 1.3;
      b.y = BOSS_Y + Math.sin(t * 0.07) * 10;
      if (!armed) break;
      if (due(t, dt, 32)) {
        b.angle += 0.2;
        b.angle2 -= 0.2;
        fireRing(eb, b.x, b.y, 24, 1.0, b.angle, KIND_BLUE);
        fireRing(eb, b.x, b.y, 24, 0.85, b.angle2, KIND_RED);
      }
      if (due(t, dt, 10)) {
        fireFan(eb, b.x, b.y, angleTo(b.x, b.y, g.px, g.py), 3, 0.3, 1.8, KIND_GREEN);
      }
      break;
  }
}

export function damageBoss(g: Game, dmg: number): void {
  const b = g.boss;
  if (!b.alive || b.entering || b.invuln > 0) return;
  b.hp -= dmg;
  g.events |= EV_BOSS_HP;
  if (b.hp > 0) return;
  pushFx(g, b.x, b.y);
  clearBullets(g.eb);
  b.phase++;
  g.score += BOSS_PHASE_SCORE;
  if (b.phase >= BOSS_HP.length) {
    b.alive = false;
    b.hp = 0;
    g.score += BOSS_KILL_SCORE;
    g.mode = MODE_CLEAR;
    g.events |= EV_MODE | EV_HUD | EV_KILL;
    return;
  }
  b.hp = BOSS_HP[b.phase];
  b.maxHp = b.hp;
  b.invuln = BOSS_PHASE_INVULN;
  b.phaseT = 0;
  g.events |= EV_PHASE | EV_HUD;
}
