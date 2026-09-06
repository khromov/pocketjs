// apps/svelte-shooter/game/state.ts — the one game object.
//
// Created once per app and reset in place: the pools are bound to host nodes
// that outlive any run, so a restart zero-fills rather than reallocates. The
// step sets bits in `events`; the component reads and clears them once per
// frame to drive sounds, tweens and HUD writes without the game knowing any
// of that exists.

import {
  BOSS_HP,
  MODE_PLAY,
  MAX_EBULLETS,
  MAX_FX,
  MAX_PBULLETS,
  PLAYER_BOTTOM,
  START_BOMBS,
  START_LIVES,
  TYPE_R,
  TYPE_SLOTS,
} from "./constants.ts";
import {
  createBulletPool,
  createEnemyPool,
  resetBulletPool,
  resetEnemyPool,
  type BulletPool,
  type EnemyPool,
} from "./pools.ts";
import { Rng } from "./rng.ts";

export interface Boss {
  spawned: boolean;
  alive: boolean;
  /** Descending into place; cannot be hurt and does not fire. */
  entering: boolean;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  phase: number;
  /** Ticks since the phase began; every pattern clock reads it. */
  phaseT: number;
  invuln: number;
  angle: number;
  angle2: number;
  targetX: number;
}

export interface Game {
  readonly w: number;
  readonly h: number;
  /** Core ticks per host frame. */
  readonly dt: number;
  readonly seed: number;
  readonly rng: Rng;
  t: number;
  mode: number;
  px: number;
  py: number;
  pInvuln: number;
  /** Ticks until respawn; 0 while alive. */
  pDead: number;
  pFireCd: number;
  lives: number;
  bombs: number;
  /** Autofire lock (RTRIGGER). Survives a restart: it is a preference. */
  lock: boolean;
  focus: boolean;
  score: number;
  graze: number;
  readonly eb: BulletPool;
  readonly pb: BulletPool;
  readonly en: EnemyPool;
  readonly boss: Boss;
  waveIdx: number;
  waveK: number;
  events: number;
  readonly fxX: Float32Array;
  readonly fxY: Float32Array;
  fxN: number;
}

export function createGame(w: number, h: number, dt: number, seed: number): Game {
  const g: Game = {
    w,
    h,
    dt,
    seed,
    rng: new Rng(seed),
    t: 0,
    mode: MODE_PLAY,
    px: w / 2,
    py: h - PLAYER_BOTTOM,
    pInvuln: 0,
    pDead: 0,
    pFireCd: 0,
    lives: START_LIVES,
    bombs: START_BOMBS,
    lock: false,
    focus: false,
    score: 0,
    graze: 0,
    eb: createBulletPool(MAX_EBULLETS),
    pb: createBulletPool(MAX_PBULLETS),
    en: createEnemyPool(TYPE_SLOTS, TYPE_R),
    boss: {
      spawned: false,
      alive: false,
      entering: false,
      x: w / 2,
      y: -40,
      hp: BOSS_HP[0],
      maxHp: BOSS_HP[0],
      phase: 0,
      phaseT: 0,
      invuln: 0,
      angle: 0,
      angle2: 0,
      targetX: w / 2,
    },
    waveIdx: 0,
    waveK: 0,
    events: 0,
    fxX: new Float32Array(MAX_FX),
    fxY: new Float32Array(MAX_FX),
    fxN: 0,
  };
  return g;
}

export function resetGame(g: Game): void {
  g.rng.reseed(g.seed);
  g.t = 0;
  g.mode = MODE_PLAY;
  g.px = g.w / 2;
  g.py = g.h - PLAYER_BOTTOM;
  g.pInvuln = 0;
  g.pDead = 0;
  g.pFireCd = 0;
  g.lives = START_LIVES;
  g.bombs = START_BOMBS;
  g.focus = false;
  g.score = 0;
  g.graze = 0;
  resetBulletPool(g.eb);
  resetBulletPool(g.pb);
  resetEnemyPool(g.en);
  const b = g.boss;
  b.spawned = false;
  b.alive = false;
  b.entering = false;
  b.x = g.w / 2;
  b.y = -40;
  b.hp = BOSS_HP[0];
  b.maxHp = BOSS_HP[0];
  b.phase = 0;
  b.phaseT = 0;
  b.invuln = 0;
  b.angle = 0;
  b.angle2 = 0;
  b.targetX = g.w / 2;
  g.waveIdx = 0;
  g.waveK = 0;
  g.events = 0;
  g.fxN = 0;
}

/** Ask the presenter for a burst at (x, y) this frame; extra requests are dropped. */
export function pushFx(g: Game, x: number, y: number): void {
  if (g.fxN >= MAX_FX) return;
  g.fxX[g.fxN] = x;
  g.fxY[g.fxN] = y;
  g.fxN++;
}
