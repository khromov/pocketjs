// Tuning constants for the Wolfensvelte port. Distances are in tiles (one
// Wolfensvelte "real" unit is 1/64 tile), times in 60 Hz frames.

/** Wolfensvelte units per tile. */
export const TILE = 64;

export const FOV_DEG = 60;
/** Screen pixels per wall column. 4 keeps the JS raycast inside the PSP budget. */
export const STRIP_W = 4;
/** Raycast every N frames (2 = 30 Hz world under 60 Hz input). */
export const RAYCAST_EVERY = 1;
export const MAX_DDA_STEPS = 48;
export const MIN_DEPTH = 0.05;
export const MAX_SPRITE_SLOTS = 24;

export const PLAYER_RADIUS = 0.25;
// Wolfensvelte moves 6.875 units and turns sin(0.825*pi)*6.875 degrees per
// game tick, and its global loop ticks 24 times a second (utils/raf.ts
// TARGET_FPS). The move speed is that rate expressed per 60 Hz frame; the
// turn rate is raised from 86 deg/s to 110 deg/s for the d-pad.
export const MOVE_SPEED = (6.875 * 24) / 60 / TILE;
export const TURN_SPEED = (110 * Math.PI) / 180 / 60;

/** svelte/motion `tweened` default duration (400 ms) drives the door slide. */
export const DOOR_SLIDE_FRAMES = 24;
/** Door.svelte closes an opened door after 5 s. */
export const DOOR_HOLD_FRAMES = 300;
/** Passage is allowed once the panel has cleared most of the opening. */
export const DOOR_PASSABLE = 0.85;
/** Pushwall.svelte tweens one tile per second. */
export const PUSHWALL_FRAMES_PER_TILE = 60;

/** Guard/state.ts tweens 64 units in 640 ms: one tile per 38.4 frames. */
export const ENEMY_SPEED = 1 / 38.4;
export const ENEMY_RADIUS = 0.3;

/** Player.svelte attack cooldowns (625 / 125 / 125 ms). */
export const PISTOL_COOLDOWN = 37;
export const SMG_COOLDOWN = 8;
export const KNIFE_COOLDOWN = 8;
export const KNIFE_RANGE = 1.5;
/** Player.svelte: enemies farther than 750 units cannot be shot. */
export const SHOT_RANGE = 750 / TILE;
/** Player.svelte: the aim cone is 35 degrees wide. */
export const SHOT_HALF_ANGLE = (35 / 2) * (Math.PI / 180);

export const DEATH_FRAMES = 150;
export const PSYCHED_FRAMES = 90;
export const LEVEL_END_FRAMES = 60;

export const CEILING_COLOR = "#383838";
export const FLOOR_COLOR = "#707070";

export const WEAPON_KNIFE = 0;
export const WEAPON_PISTOL = 1;
export const WEAPON_SMG = 2;
