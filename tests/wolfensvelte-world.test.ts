import { describe, expect, test } from "bun:test";
import { PathFinder } from "../apps/wolfensvelte/game/astar.ts";
import { WALL_CELL } from "../apps/wolfensvelte/game/atlas.ts";
import { WEAPON_PISTOL, WEAPON_SMG } from "../apps/wolfensvelte/game/constants.ts";
import { KIND_DOG, KIND_GUARD, ST_DEAD, ST_DYING, ST_WALK } from "../apps/wolfensvelte/game/enemies.ts";
import { Game } from "../apps/wolfensvelte/game/game.ts";
import { E1M1, levelFromAscii } from "../apps/wolfensvelte/game/level.ts";
import { EMPTY_INPUT, type PlayerInput } from "../apps/wolfensvelte/game/player.ts";
import { CarmackRng } from "../apps/wolfensvelte/game/rng.ts";
import { PICKUP_AMMO, PICKUP_MEDKIT, World } from "../apps/wolfensvelte/game/world.ts";

const input = (over: Partial<PlayerInput>): PlayerInput => ({ ...EMPTY_INPUT, ...over });

describe("wolfensvelte E1M1 data", () => {
  test("the cooked level carries Wolfensvelte's E1M1 counts", () => {
    const world = new World(E1M1);
    expect(world.w).toBe(64);
    expect(world.h).toBe(64);
    expect(world.doors.length).toBe(22);
    expect(world.objects.length).toBe(116);
    expect(world.pushwalls.length).toBe(4);
    expect(E1M1.enemies.length / 3).toBe(21);
    let guards = 0;
    let dogs = 0;
    for (let i = 2; i < E1M1.enemies.length; i += 3) {
      if (E1M1.enemies[i] === KIND_GUARD) guards++;
      else if (E1M1.enemies[i] === KIND_DOG) dogs++;
    }
    expect(guards).toBe(18);
    expect(dogs).toBe(3);
    let walls = 0;
    for (let i = 0; i < world.grid.length; i++) if (world.grid[i] !== 0) walls++;
    expect(walls).toBe(642);
  });

  test("the spawn tile is open floor facing the first door", () => {
    const world = new World(E1M1);
    expect(E1M1.spawn).toEqual({ x: 29.5, y: 47.5, angle: 0 });
    expect(world.isSolid(29, 47, false)).toBe(false);
    // Two tiles east is the first door of the level.
    expect(world.doorAt[world.index(31, 47)]).toBeGreaterThanOrEqual(0);
  });

  test("every wall cell in the grid points at a light face with a dark neighbour", () => {
    const world = new World(E1M1);
    const lightCells = new Set(Object.values(WALL_CELL));
    for (let i = 0; i < world.grid.length; i++) {
      const g = world.grid[i];
      if (g === 0) continue;
      expect(lightCells.has(g - 1)).toBe(true);
      expect((g - 1) % 2).toBe(0);
    }
  });
});

describe("wolfensvelte pathfinding", () => {
  test("A* threads the corridor and stops short of walls", () => {
    const world = new World(
      levelFromAscii([
        "#########",
        "#...#...#",
        "#.#.#.#.#",
        "#.#...#.#",
        "#########",
      ]),
    );
    const finder = new PathFinder(world.w, world.h);
    const passable = (i: number) => world.grid[i] === 0;
    const path = finder.find(1, 1, 7, 1, passable);
    expect(path.length).toBe(10);
    const last = path[path.length - 1];
    expect(last % world.w).toBe(7);
    expect(Math.floor(last / world.w)).toBe(1);
    for (const i of path) expect(world.grid[i]).toBe(0);
  });

  test("an unreachable goal yields the closest approach", () => {
    const world = new World(levelFromAscii(["#######", "#..#..#", "#..#..#", "#######"]));
    const finder = new PathFinder(world.w, world.h);
    const path = finder.find(1, 1, 5, 2, (i) => world.grid[i] === 0);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1] % world.w).toBe(2);
  });
});

describe("wolfensvelte game", () => {
  test("walking forward from the spawn moves the player and stops at the wall", () => {
    const game = new Game();
    const start = game.player.x;
    for (let f = 0; f < 30; f++) game.update(input({ forward: 1 }));
    expect(game.player.x).toBeGreaterThan(start + 1);
    for (let f = 0; f < 200; f++) game.update(input({ forward: 1 }));
    // The shut door at x = 31 blocks; the player parks in front of it.
    expect(game.player.x).toBeLessThan(31);
    expect(game.player.x).toBeGreaterThan(30);
  });

  test("using the door in front opens it and the player can pass", () => {
    const game = new Game();
    for (let f = 0; f < 200; f++) game.update(input({ forward: 1 }));
    game.update(input({ use: true }));
    expect(game.sfx).toContain("door-open");
    for (let f = 0; f < 120; f++) game.update(input({ forward: 1 }));
    expect(game.player.x).toBeGreaterThan(32);
  });

  test("pickups apply their effects and disappear", () => {
    const world = new World(levelFromAscii(["#####", "#...#", "#####"]));
    world.addObject(2, 1, PICKUP_AMMO);
    world.addObject(3, 1, PICKUP_MEDKIT);
    const game = new Game(levelFromAscii(["#####", "#...#", "#####"]));
    game.world = world;
    game.player.health = 50;
    for (let f = 0; f < 90; f++) game.update(input({ forward: 1 }));
    expect(game.player.ammo).toBe(12);
    expect(game.player.health).toBe(75);
    expect(world.objects.every((o) => !o.alive)).toBe(true);
  });

  test("firing costs ammo and hurts the guard in the cone", () => {
    const level = levelFromAscii(["#########", "#.......#", "#########"]);
    const game = new Game({ ...level, enemies: [5, 1, KIND_GUARD] }, 7);
    expect(game.player.weapon).toBe(WEAPON_PISTOL);
    const guard = game.enemies.list[0];
    let shots = 0;
    for (let f = 0; f < 600 && guard.alive; f++) {
      const before = game.player.ammo;
      game.update(input({ fire: true }));
      if (game.player.ammo < before) shots++;
      if (game.player.ammo === 0) game.player.ammo = 8;
    }
    expect(shots).toBeGreaterThan(0);
    expect(guard.alive).toBe(false);
    expect(game.player.score).toBe(100);
    // The guard dropped ammo next to (or on) its tile.
    expect(game.world.objects.some((o) => o.alive && o.tex === PICKUP_AMMO)).toBe(true);
    for (let f = 0; f < 60; f++) game.update(EMPTY_INPUT);
    expect(guard.state === ST_DYING || guard.state === ST_DEAD).toBe(true);
  });

  test("a guard that sees the player closes in and eventually shoots", () => {
    const level = levelFromAscii(["############", "#..........#", "#..........#", "############"]);
    const game = new Game({ ...level, enemies: [9, 1, KIND_GUARD] }, 3);
    const guard = game.enemies.list[0];
    let walked = false;
    let hurt = false;
    for (let f = 0; f < 1800 && !hurt; f++) {
      game.update(EMPTY_INPUT);
      if (guard.state === ST_WALK) walked = true;
      if (game.player.health < 100) hurt = true;
    }
    expect(game.sfx).toContain("guard-halt");
    expect(game.sfx).toContain("guard-shoot");
    expect(hurt).toBe(true);
    // It either closed in on foot or opened fire from where it stood.
    expect(walked || guard.x === 9.5).toBe(true);
  });

  test("the smg pickup arms the third weapon", () => {
    const level = levelFromAscii(["#####", "#...#", "#####"]);
    const game = new Game({ ...level, objects: [2, 1, 144] });
    for (let f = 0; f < 40; f++) game.update(input({ forward: 1 }));
    expect(game.player.hasSmg).toBe(true);
    game.update(input({ selectWeapon: WEAPON_SMG }));
    expect(game.player.weapon).toBe(WEAPON_SMG);
  });

  test("the seeded generator replays", () => {
    const a = new CarmackRng(42);
    const b = new CarmackRng(42);
    for (let i = 0; i < 50; i++) expect(a.nextInt(0, 255)).toBe(b.nextInt(0, 255));
  });
});
