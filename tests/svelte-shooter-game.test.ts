// Headless journeys over apps/svelte-shooter/game: no build, no sim, no
// framework import. The level is a pure function of (seed, input tape), so
// the numbers pinned here are the level's fingerprint.

import { describe, expect, test } from "bun:test";
import {
  INVULN_TICKS,
  MAX_EBULLETS,
  MAX_ENEMIES,
  MAX_PBULLETS,
  MODE_CLEAR,
  MODE_OVER,
  MODE_PAUSE,
  MODE_PLAY,
  SEED,
  START_BOMBS,
} from "../apps/svelte-shooter/game/constants.ts";
import { computeLayout } from "../apps/svelte-shooter/game/layout.ts";
import { BOSS_AT, WAVES } from "../apps/svelte-shooter/game/level.ts";
import { Rng } from "../apps/svelte-shooter/game/rng.ts";
import { createGame, type Game } from "../apps/svelte-shooter/game/state.ts";
import { restart, stepGame, togglePause, useBomb, type Input } from "../apps/svelte-shooter/game/step.ts";

const IDLE: Input = { mx: 0, my: 0, fire: false, focus: false };

/** Lock on, invulnerable, and always sliding under the nearest target. */
function godStep(g: Game, inp: Input): void {
  g.pInvuln = INVULN_TICKS;
  let tx = g.w / 2;
  if (g.boss.alive) {
    tx = g.boss.x;
  } else {
    let best = Infinity;
    const en = g.en;
    for (let i = 0; i < en.n; i++) {
      if (!en.alive[i] || en.y[i] <= 0 || en.y[i] >= g.py) continue;
      const d = Math.abs(en.x[i] - g.px);
      if (d < best) {
        best = d;
        tx = en.x[i];
      }
    }
  }
  inp.mx = tx > g.px + 2 ? 1 : tx < g.px - 2 ? -1 : 0;
  stepGame(g, inp);
}

describe("svelte-shooter layout", () => {
  test("a single 480x272 screen splits into the playfield and a side panel", () => {
    expect(computeLayout(480, 272, false)).toEqual({ playW: 288, playH: 272, hudW: 192 });
  });
  test("the 3DS top screen is all playfield when the HUD has its own screen", () => {
    expect(computeLayout(400, 240, true)).toEqual({ playW: 400, playH: 240, hudW: 0 });
  });
  test("a 400x240 host without a second screen keeps a minimum side panel", () => {
    expect(computeLayout(400, 240, false)).toEqual({ playW: 288, playH: 240, hudW: 112 });
  });
});

describe("svelte-shooter rng", () => {
  test("the same seed replays the same sequence", () => {
    const a = new Rng(SEED);
    const b = new Rng(SEED);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
    const f = a.float();
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });
});

describe("svelte-shooter level", () => {
  test("an idle ship loses its three lives on fixed ticks", () => {
    const g = createGame(288, 272, 1, SEED);
    const deaths: number[] = [];
    let lives = g.lives;
    for (let t = 0; t < 3000 && g.mode === MODE_PLAY; t++) {
      stepGame(g, IDLE);
      if (g.lives < lives) {
        lives = g.lives;
        deaths.push(g.t);
      }
    }
    expect(deaths).toEqual([226, 506, 666]);
    expect(g.mode).toBe(MODE_OVER);
  });

  test("a locked-on invulnerable ship clears every wave and the boss within the pools", () => {
    const g = createGame(288, 272, 1, SEED);
    g.lock = true;
    const inp: Input = { mx: 0, my: 0, fire: true, focus: false };
    let phases = 0;
    let seen = -1;
    while (g.mode === MODE_PLAY && g.t < 12000) {
      godStep(g, inp);
      if (g.boss.alive && g.boss.phase !== seen) {
        seen = g.boss.phase;
        phases++;
      }
    }
    expect(g.mode).toBe(MODE_CLEAR);
    expect(g.waveIdx).toBe(WAVES.length);
    expect(phases).toBe(4);
    expect(g.t).toBeGreaterThan(BOSS_AT);
    expect(g.eb.peak).toBeLessThanOrEqual(MAX_EBULLETS);
    expect(g.eb.peak).toBeGreaterThan(250); // the boss actually fills the screen
    expect(g.eb.dropped).toBe(0); // and no pattern starves its kind
    expect(g.pb.peak).toBeLessThanOrEqual(MAX_PBULLETS);
    expect(g.en.peak).toBeLessThanOrEqual(MAX_ENEMIES);
  });

  test("two ticks per host frame plays the same level", () => {
    const g = createGame(288, 272, 2, SEED);
    g.lock = true;
    const inp: Input = { mx: 0, my: 0, fire: true, focus: false };
    while (g.mode === MODE_PLAY && g.t < 12000) godStep(g, inp);
    expect(g.mode).toBe(MODE_CLEAR);
    expect(g.waveIdx).toBe(WAVES.length);
  });

  test("the 400 px field runs the same script", () => {
    const g = createGame(400, 240, 1, SEED);
    g.lock = true;
    const inp: Input = { mx: 0, my: 0, fire: true, focus: false };
    while (g.mode === MODE_PLAY && g.t < 12000) godStep(g, inp);
    expect(g.mode).toBe(MODE_CLEAR);
  });
});

describe("svelte-shooter player", () => {
  test("a bomb clears the screen, costs one bomb and grants invulnerability", () => {
    const g = createGame(288, 272, 1, SEED);
    for (let t = 0; t < 200; t++) stepGame(g, IDLE);
    expect(g.eb.count).toBeGreaterThan(0);
    expect(useBomb(g)).toBe(true);
    expect(g.bombs).toBe(START_BOMBS - 1);
    expect(g.eb.count).toBe(0);
    expect(g.pInvuln).toBeGreaterThan(0);
    useBomb(g);
    useBomb(g);
    expect(g.bombs).toBe(0);
    expect(useBomb(g)).toBe(false);
  });

  test("holding fire slows the ship", () => {
    const fast = createGame(288, 272, 1, SEED);
    const slow = createGame(288, 272, 1, SEED);
    for (let t = 0; t < 20; t++) {
      stepGame(fast, { mx: 1, my: 0, fire: false, focus: false });
      stepGame(slow, { mx: 1, my: 0, fire: true, focus: true });
    }
    expect(slow.px - slow.w / 2).toBeLessThan(fast.px - fast.w / 2);
    expect(slow.pb.count).toBeGreaterThan(0);
    expect(fast.pb.count).toBe(0);
  });

  test("lock fires without the button and survives a restart", () => {
    const g = createGame(288, 272, 1, SEED);
    g.lock = true;
    for (let t = 0; t < 10; t++) stepGame(g, IDLE);
    expect(g.pb.count).toBeGreaterThan(0);
    for (let t = 0; t < 3000 && g.mode === MODE_PLAY; t++) stepGame(g, IDLE);
    expect(g.mode).toBe(MODE_OVER);
    restart(g);
    expect(g.mode).toBe(MODE_PLAY);
    expect(g.lives).toBe(3);
    expect(g.score).toBe(0);
    expect(g.t).toBe(0);
    expect(g.lock).toBe(true);
    expect(g.eb.count).toBe(0);
  });

  test("pause freezes the clock", () => {
    const g = createGame(288, 272, 1, SEED);
    stepGame(g, IDLE);
    togglePause(g);
    expect(g.mode).toBe(MODE_PAUSE);
    for (let t = 0; t < 50; t++) stepGame(g, IDLE);
    expect(g.t).toBe(1);
    togglePause(g);
    stepGame(g, IDLE);
    expect(g.t).toBe(2);
  });
});
