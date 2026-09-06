// The level as typed-array grids plus the things that change it: doors,
// secret pushwalls, decorations and pickups, the elevator. This is the port of
// Level.svelte's store (collision rules, pickups), Door.svelte, Pushwall.svelte
// and Elevator.svelte, minus their DOM.

import {
  DOOR_HOLD_FRAMES,
  DOOR_PASSABLE,
  DOOR_SLIDE_FRAMES,
  PUSHWALL_FRAMES_PER_TILE,
} from "./constants.ts";
import { ELEVATOR_ON_CELL, OBJECT_CELL } from "./atlas.ts";
import { E1M1, type LevelData } from "./level.ts";

export const DOOR_CLOSED = 0;
export const DOOR_OPENING = 1;
export const DOOR_OPEN = 2;
export const DOOR_CLOSING = 3;

export interface Door {
  readonly x: number;
  readonly y: number;
  /** Wall-atlas cell of the panel texture. */
  readonly cell: number;
  /** True: the door sits in a north-south wall (plane x + 0.5, slides along +y). */
  readonly vertical: boolean;
  /** 0 = shut .. 1 = fully retracted. */
  open: number;
  state: number;
  /** Frames left before an open door starts closing. */
  hold: number;
}

export interface Pushwall {
  x: number;
  y: number;
  readonly cell: number;
  dx: number;
  dy: number;
  /** Slide progress out of (x, y) toward (x + dx, y + dy). */
  t: number;
  moving: boolean;
  spent: boolean;
}

export interface WorldObject {
  readonly x: number;
  readonly y: number;
  /** Wolfensvelte texture id, which also names the pickup kind. */
  readonly tex: number;
  readonly cell: number;
  readonly blocking: boolean;
  alive: boolean;
}

// utils/engine/objects.ts noClipObjectIds: everything else with an Object
// model blocks movement.
const NO_CLIP = new Set([131, 121, 155, 151, 165, 143, 142, 144, 145, 146, 147, 123, 148, 149, 150, 138, 137, 126, 141, 168]);

export const PICKUP_CROSS = 146;
export const PICKUP_GOBLET = 147;
export const PICKUP_CHEST = 148;
export const PICKUP_CROWN = 149;
export const PICKUP_SMG = 144;
export const PICKUP_AMMO = 143;
export const PICKUP_MEDKIT = 142;
export const PICKUP_FOOD = 141;
export const PICKUP_DOGFOOD = 123;
export const PICKUP_IDS = new Set([
  PICKUP_CROSS, PICKUP_GOBLET, PICKUP_CHEST, PICKUP_CROWN, PICKUP_SMG, PICKUP_AMMO,
  PICKUP_MEDKIT, PICKUP_FOOD, PICKUP_DOGFOOD,
]);

export type UseResult = "door" | "pushwall" | "elevator" | null;

export class World {
  readonly level: LevelData;
  readonly w: number;
  readonly h: number;
  /** Light-face atlas cell + 1 per tile; 0 = no wall. Dark face = cell + 1. */
  readonly grid: Uint8Array;
  /** Door index per tile, -1 = none. */
  readonly doorAt: Int16Array;
  /** Pushwall index for the two tiles a moving block spans, -1 = none. */
  readonly slabAt: Int8Array;
  /** Count of blocking decorations per tile. */
  readonly objectBlock: Uint8Array;
  /** Set by the enemy manager: 1 where a live enemy stands. */
  readonly enemyBlock: Uint8Array;
  readonly elevatorAt: Uint8Array;
  readonly doors: Door[] = [];
  readonly pushwalls: Pushwall[] = [];
  readonly objects: WorldObject[] = [];
  /** Sound effect names queued this frame; drained by the app. */
  readonly sfx: string[] = [];
  elevatorUsed = false;

  constructor(level: LevelData = E1M1) {
    this.level = level;
    this.w = level.w;
    this.h = level.h;
    const n = this.w * this.h;
    this.grid = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.grid[i] = level.grid.charCodeAt(i) - 32;
    this.doorAt = new Int16Array(n).fill(-1);
    this.slabAt = new Int8Array(n).fill(-1);
    this.objectBlock = new Uint8Array(n);
    this.enemyBlock = new Uint8Array(n);
    this.elevatorAt = new Uint8Array(n);
    const { doors, pushwalls, objects, elevators } = level;
    for (let i = 0; i < doors.length; i += 4) {
      const x = doors[i];
      const y = doors[i + 1];
      this.doorAt[y * this.w + x] = this.doors.length;
      this.doors.push({ x, y, cell: doors[i + 2], vertical: doors[i + 3] === 1, open: 0, state: DOOR_CLOSED, hold: 0 });
    }
    for (let i = 0; i < pushwalls.length; i += 2) {
      const x = pushwalls[i];
      const y = pushwalls[i + 1];
      this.pushwalls.push({ x, y, cell: this.grid[y * this.w + x] - 1, dx: 0, dy: 0, t: 0, moving: false, spent: false });
    }
    for (let i = 0; i < objects.length; i += 3) {
      this.addObject(objects[i], objects[i + 1], objects[i + 2]);
    }
    for (let i = 0; i < elevators.length; i += 2) {
      this.elevatorAt[elevators[i + 1] * this.w + elevators[i]] = 1;
    }
  }

  index(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  isWall(x: number, y: number): boolean {
    return !this.inBounds(x, y) || this.grid[y * this.w + x] !== 0;
  }

  addObject(x: number, y: number, tex: number): WorldObject {
    const cell = OBJECT_CELL[tex];
    if (cell === undefined) throw new Error(`wolfensvelte: object texture ${tex} is not in the sprite atlas`);
    const blocking = !NO_CLIP.has(tex);
    const obj: WorldObject = { x, y, tex, cell, blocking, alive: true };
    if (blocking) this.objectBlock[y * this.w + x]++;
    this.objects.push(obj);
    return obj;
  }

  removeObject(obj: WorldObject): void {
    if (!obj.alive) return;
    obj.alive = false;
    if (obj.blocking) this.objectBlock[obj.y * this.w + obj.x]--;
  }

  /** A pickup on the tile, if any (the player's collision test consumes it). */
  pickupAt(x: number, y: number): WorldObject | null {
    for (const o of this.objects) {
      if (o.alive && o.x === x && o.y === y && PICKUP_IDS.has(o.tex)) return o;
    }
    return null;
  }

  /** Tile blocks a moving body. Enemies are excluded so a walker never blocks itself. */
  isSolid(x: number, y: number, includeEnemies: boolean): boolean {
    if (!this.inBounds(x, y)) return true;
    const i = y * this.w + x;
    if (this.grid[i] !== 0 || this.slabAt[i] >= 0 || this.objectBlock[i] > 0) return true;
    if (includeEnemies && this.enemyBlock[i] !== 0) return true;
    const d = this.doorAt[i];
    if (d >= 0 && this.doors[d].open < DOOR_PASSABLE) return true;
    return false;
  }

  /** Tile blocks sight (walls, moving blocks, doors less than half open). */
  blocksSight(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    const i = y * this.w + x;
    if (this.grid[i] !== 0 || this.slabAt[i] >= 0) return true;
    const d = this.doorAt[i];
    return d >= 0 && this.doors[d].open < 0.5;
  }

  /** Bresenham over tiles between two centres, as Player.svelte testLineOfSight2. */
  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    let x = x0;
    let y = y0;
    const sx = x1 > x0 ? 1 : -1;
    const sy = y1 > y0 ? 1 : -1;
    let err = dx - dy;
    dx *= 2;
    dy *= 2;
    for (let n = 1 + (dx >> 1) + (dy >> 1); n > 0; n--) {
      if ((x !== x0 || y !== y0) && this.blocksSight(x, y)) return false;
      if (x === x1 && y === y1) return true;
      if (err > 0) {
        x += sx;
        err -= dy;
      } else {
        y += sy;
        err += dx;
      }
    }
    return true;
  }

  /** Advance door slides, hold timers and pushwall motion by one frame. */
  update(occupied: (x: number, y: number) => boolean): void {
    for (const d of this.doors) {
      if (d.state === DOOR_OPENING) {
        d.open += 1 / DOOR_SLIDE_FRAMES;
        if (d.open >= 1) {
          d.open = 1;
          d.state = DOOR_OPEN;
          d.hold = DOOR_HOLD_FRAMES;
        }
      } else if (d.state === DOOR_OPEN) {
        if (--d.hold <= 0) {
          // Door.svelte re-arms the timer when something stands in the way.
          if (occupied(d.x, d.y)) d.hold = DOOR_HOLD_FRAMES;
          else {
            d.state = DOOR_CLOSING;
            this.sfx.push("door-close");
          }
        }
      } else if (d.state === DOOR_CLOSING) {
        d.open -= 1 / DOOR_SLIDE_FRAMES;
        if (d.open <= 0) {
          d.open = 0;
          d.state = DOOR_CLOSED;
        }
      }
    }
    for (let i = 0; i < this.pushwalls.length; i++) {
      const p = this.pushwalls[i];
      if (!p.moving) continue;
      p.t += 1 / PUSHWALL_FRAMES_PER_TILE;
      if (p.t < 1) continue;
      // Arrived at the next tile: the block now originates there.
      this.slabAt[this.index(p.x, p.y)] = -1;
      p.x += p.dx;
      p.y += p.dy;
      p.t = 0;
      const nx = p.x + p.dx;
      const ny = p.y + p.dy;
      const canContinue = this.inBounds(nx, ny) && this.grid[this.index(nx, ny)] === 0 && this.doorAt[this.index(nx, ny)] < 0 && this.slabAt[this.index(nx, ny)] < 0;
      if (canContinue) {
        this.slabAt[this.index(nx, ny)] = i;
      } else {
        this.slabAt[this.index(p.x, p.y)] = -1;
        this.grid[this.index(p.x, p.y)] = p.cell + 1;
        p.moving = false;
      }
    }
  }

  toggleDoor(d: Door, occupied: (x: number, y: number) => boolean): void {
    if (d.state === DOOR_CLOSED || d.state === DOOR_CLOSING) {
      d.state = DOOR_OPENING;
      this.sfx.push("door-open");
    } else if (!occupied(d.x, d.y)) {
      d.state = DOOR_CLOSING;
      this.sfx.push("door-close");
    }
  }

  /**
   * The use action on the tile in front of the player (Player.svelte
   * interactWithDoor + Pushwall/Elevator toggleAction). `dx`/`dy` is the
   * cardinal facing direction.
   */
  use(tileX: number, tileY: number, dx: number, dy: number, occupied: (x: number, y: number) => boolean): UseResult {
    const x = tileX + dx;
    const y = tileY + dy;
    if (!this.inBounds(x, y)) return null;
    const i = this.index(x, y);
    const d = this.doorAt[i];
    if (d >= 0) {
      this.toggleDoor(this.doors[d], occupied);
      return "door";
    }
    if (this.elevatorAt[i] !== 0 && !this.elevatorUsed) {
      this.elevatorUsed = true;
      this.grid[i] = ELEVATOR_ON_CELL + 1;
      return "elevator";
    }
    for (let p = 0; p < this.pushwalls.length; p++) {
      const pw = this.pushwalls[p];
      if (pw.x !== x || pw.y !== y || pw.spent || pw.moving) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!this.inBounds(nx, ny) || this.grid[this.index(nx, ny)] !== 0 || this.doorAt[this.index(nx, ny)] >= 0) return null;
      pw.dx = dx;
      pw.dy = dy;
      pw.t = 0;
      pw.moving = true;
      pw.spent = true;
      this.grid[i] = 0;
      this.slabAt[i] = p;
      this.slabAt[this.index(nx, ny)] = p;
      return "pushwall";
    }
    return null;
  }
}
