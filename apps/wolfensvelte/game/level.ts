// Level data shape shared by the cooked E1M1 and the unit tests' tiny maps.

import {
  LEVEL_DOORS,
  LEVEL_ELEVATORS,
  LEVEL_ENEMIES,
  LEVEL_GRID,
  LEVEL_H,
  LEVEL_OBJECTS,
  LEVEL_PUSHWALLS,
  LEVEL_SPAWN,
  LEVEL_W,
} from "./level-e1m1.ts";

export interface LevelData {
  readonly w: number;
  readonly h: number;
  /** Row-major, one char per tile: charCode - 32 = light-face atlas cell + 1, 0 = floor. */
  readonly grid: string;
  /** [x, y, atlasCell, vertical] per door. */
  readonly doors: readonly number[];
  /** [x, y, textureId] per decoration or pickup. */
  readonly objects: readonly number[];
  /** [x, y, kind] per enemy (0 = guard, 1 = dog). */
  readonly enemies: readonly number[];
  /** [x, y] per pushwall. */
  readonly pushwalls: readonly number[];
  /** [x, y] per elevator switch tile. */
  readonly elevators: readonly number[];
  readonly spawn: { readonly x: number; readonly y: number; readonly angle: number };
}

export const E1M1: LevelData = {
  w: LEVEL_W,
  h: LEVEL_H,
  grid: LEVEL_GRID,
  doors: LEVEL_DOORS,
  objects: LEVEL_OBJECTS,
  enemies: LEVEL_ENEMIES,
  pushwalls: LEVEL_PUSHWALLS,
  elevators: LEVEL_ELEVATORS,
  spawn: LEVEL_SPAWN,
};

/**
 * Build a level from an ASCII picture for tests: `#` = wall (atlas cell 0),
 * digits = wall with that atlas cell, `D` = door in an east-west wall,
 * `|` = door in a north-south wall, `P` = pushwall, `E` = elevator, `.` = floor.
 */
export function levelFromAscii(rows: readonly string[], spawn = { x: 1.5, y: 1.5, angle: 0 }): LevelData {
  const h = rows.length;
  const w = rows[0].length;
  let grid = "";
  const doors: number[] = [];
  const pushwalls: number[] = [];
  const elevators: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      let v = 0;
      if (c === "#" || c === "P" || c === "E") v = 1;
      else if (c >= "0" && c <= "9") v = c.charCodeAt(0) - 48 + 1;
      else if (c === "D") doors.push(x, y, 0, 0);
      else if (c === "|") doors.push(x, y, 0, 1);
      if (c === "P") pushwalls.push(x, y);
      if (c === "E") elevators.push(x, y);
      grid += String.fromCharCode(32 + v);
    }
  }
  return { w, h, grid, doors, objects: [], enemies: [], pushwalls, elevators, spawn };
}
