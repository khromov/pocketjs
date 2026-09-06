// apps/svelte-shooter/game/constants.ts — every tunable in one place.
//
// Distances are logical pixels, times are core ticks (60 per second). The
// step multiplies every rate by `dt` = ticks per host frame, so a 30 Hz host
// plays the same level at the same speed.

export const SEED = 0x9e3779b9;

/** Wave x positions are authored for this playfield width and scaled to the real one. */
export const FIELD_REF_W = 288;

// Player -------------------------------------------------------------------
export const PLAYER_SPEED = 2.6;
/** Holding fire slows the ship for threading dense patterns. */
export const FOCUS_SPEED = 1.3;
/** Hit radius of the core dot, not the sprite. */
export const PLAYER_R = 2.5;
/** Bullets passing inside this radius (but outside PLAYER_R) score a graze once. */
export const GRAZE_R = 11;
export const PLAYER_MARGIN = 14;
/** Spawn height above the bottom edge. */
export const PLAYER_BOTTOM = 36;
export const FIRE_CD = 5;
export const PB_SPEED = 7;
export const PB_DAMAGE = 2;
export const PB_HALF_W = 3;
export const PB_HALF_H = 12;
export const START_LIVES = 3;
export const START_BOMBS = 3;
export const INVULN_TICKS = 120;
export const RESPAWN_TICKS = 40;
export const BOMB_INVULN = 90;
export const BOMB_ENEMY_DMG = 40;
export const BOMB_BOSS_DMG = 60;
export const GRAZE_SCORE = 10;

// Enemy bullets: the kind is fixed per pool slot (one texture per kind). --
export const KIND_RED = 0;
export const KIND_BLUE = 1;
export const KIND_GREEN = 2;
export const KIND_SLOTS = [80, 48, 64] as const;
export const KIND_R = [4.5, 5, 3] as const;
export const MAX_EBULLETS = 192;
export const MAX_PBULLETS = 24;

// Enemies ------------------------------------------------------------------
export const TYPE_DRONE = 0;
export const TYPE_GUNSHIP = 1;
export const TYPE_HEAVY = 2;
export const TYPE_SLOTS = [8, 6, 2] as const;
export const TYPE_R = [10, 12, 20] as const;
export const TYPE_SCORE = [100, 300, 800] as const;
export const MAX_ENEMIES = 16;
/** One-shot burst nodes; the game requests at most this many per frame. */
export const MAX_FX = 8;
/** Bullets and enemies die this far outside the playfield. */
export const CULL_MARGIN = 16;

// Boss ---------------------------------------------------------------------
export const BOSS_R = 26;
export const BOSS_Y = 60;
export const BOSS_HP = [240, 300, 360, 420] as const;
export const BOSS_ENTER_SPEED = 1;
export const BOSS_PHASE_INVULN = 60;
export const BOSS_PHASE_SCORE = 2000;
export const BOSS_KILL_SCORE = 10000;

// Modes and per-frame event bits -------------------------------------------
export const MODE_PLAY = 0;
export const MODE_PAUSE = 1;
export const MODE_OVER = 2;
export const MODE_CLEAR = 3;

export const EV_HUD = 1;
export const EV_BOMB = 2;
export const EV_PLAYER_HIT = 4;
export const EV_BOSS_HP = 8;
export const EV_MODE = 16;
export const EV_SHOT = 32;
export const EV_KILL = 64;
export const EV_PHASE = 128;
export const EV_BOSS_ENTER = 256;
export const EV_HIT = 512;
export const EV_GRAZE = 1024;
