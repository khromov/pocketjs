// Guards and dogs: the port of Enemy.svelte + Guard/state.ts + core/ai.ts.
// Each enemy is a small state machine ticked once per frame; decisions run on
// the original reaction timers, movement follows an A* path one tile at a
// time, and sprite cells come from per-state frame tables over the atlas.

import { DOG_CELL0, DOG_SHEET_COLS, GUARD_CELL0 } from "./atlas.ts";
import { PathFinder } from "./astar.ts";
import { ENEMY_SPEED, TILE } from "./constants.ts";
import type { Player } from "./player.ts";
import type { CarmackRng } from "./rng.ts";
import { PICKUP_AMMO, type World } from "./world.ts";

export const KIND_GUARD = 0;
export const KIND_DOG = 1;

export const ST_IDLE = 0;
export const ST_WALK = 1;
export const ST_ATTACK = 2;
export const ST_HURT = 3;
export const ST_DYING = 4;
export const ST_DEAD = 5;

interface Anim {
  idle: readonly number[];
  walk: readonly number[];
  walkStep: number;
  attack: readonly number[];
  attackStep: number;
  /** Frame of the attack state at which damage lands. */
  attackHit: number;
  hurt: readonly number[];
  hurtStep: number;
  dying: readonly number[];
  dyingStep: number;
  dead: number;
}

interface Behavior {
  health: number;
  /** Frames between decisions (core/ai.ts reactionTime). */
  reaction: number;
  rangeMin: number;
  rangeMax: number;
  points: number;
  drop: number | null;
  alert: string;
  attack: string | null;
  deaths: readonly string[];
  anim: Anim;
}

const G = GUARD_CELL0;
const dog = (col: number, row: number): number => DOG_CELL0 + row * DOG_SHEET_COLS + col;

// Frame tables read from Enemy.svelte's keyframes (guard sheet frame indices;
// dog sheet background-position cells).
const GUARD: Behavior = {
  health: 25,
  reaction: 93,
  rangeMin: 55 / TILE,
  rangeMax: 900 / TILE,
  points: 100,
  drop: PICKUP_AMMO,
  alert: "guard-halt",
  attack: "guard-shoot",
  deaths: ["guard-death-1", "guard-death-2", "guard-death-3"],
  anim: {
    idle: [G],
    walk: [G + 1, G + 2, G + 3, G + 4],
    walkStep: 16,
    attack: [G + 11, G + 12],
    attackStep: 20,
    attackHit: 20,
    hurt: [G + 9],
    hurtStep: 20,
    dying: [G + 5, G + 6, G + 7, G + 8],
    dyingStep: 10,
    dead: G + 10,
  },
};

const DOG: Behavior = {
  health: 15,
  reaction: 6,
  rangeMin: 1 / TILE,
  rangeMax: 1,
  points: 500,
  drop: null,
  alert: "dog-bark",
  attack: null,
  deaths: ["dog-death"],
  anim: {
    idle: [dog(0, 3)],
    walk: [dog(2, 1), dog(2, 2), dog(0, 3), dog(1, 3)],
    walkStep: 9,
    attack: [dog(0, 1), dog(0, 0), dog(1, 0)],
    attackStep: 12,
    attackHit: 12,
    hurt: [dog(1, 2), dog(2, 0)],
    hurtStep: 12,
    dying: [dog(0, 2), dog(1, 1)],
    dyingStep: 33,
    dead: dog(1, 1),
  },
};

const BEHAVIOR: readonly Behavior[] = [GUARD, DOG];

/** Enemies notice the player within 1500 units and forget past 1000 (Enemy.svelte). */
const SIGHT_RANGE = 1500 / TILE;
const FORGET_RANGE = 1000 / TILE;
const DOG_BITE_RANGE = 1.5;

export class Enemy {
  readonly kind: number;
  readonly behavior: Behavior;
  x: number;
  y: number;
  health: number;
  state = ST_IDLE;
  stateFrame = 0;
  /** Frames until the next decision. */
  decision: number;
  seen = false;
  /** A hit forces the next decision to attack (Enemy.svelte hasTakenDamage). */
  hurtPending = false;
  /** Sprite atlas cell to draw. */
  cell: number;
  /** Tile currently reserved in world.enemyBlock. */
  tileX: number;
  tileY: number;
  /** Tile being walked into, or -1. */
  targetX = -1;
  targetY = -1;
  path: number[] = [];
  pathIdx = 0;

  constructor(kind: number, x: number, y: number, decision: number) {
    this.kind = kind;
    this.behavior = BEHAVIOR[kind];
    this.x = x;
    this.y = y;
    this.health = this.behavior.health;
    this.decision = decision;
    this.cell = this.behavior.anim.idle[0];
    this.tileX = Math.floor(x);
    this.tileY = Math.floor(y);
  }

  get alive(): boolean {
    return this.state < ST_DYING;
  }
}

export class EnemyManager {
  readonly list: Enemy[] = [];
  private readonly finder: PathFinder;
  private readonly passable: (i: number) => boolean;

  constructor(world: World, enemies: readonly number[], rng: CarmackRng) {
    this.finder = new PathFinder(world.w, world.h);
    // helpers/ai.ts findPath: enemies walk floor tiles only, never through doors.
    this.passable = (i) => world.grid[i] === 0 && world.doorAt[i] < 0 && world.objectBlock[i] === 0 && world.slabAt[i] < 0;
    for (let i = 0; i < enemies.length; i += 3) {
      const e = new Enemy(enemies[i + 2], enemies[i] + 0.5, enemies[i + 1] + 0.5, rng.nextInt(10, 40));
      world.enemyBlock[world.index(e.tileX, e.tileY)] = 1;
      this.list.push(e);
    }
  }

  private release(world: World, e: Enemy): void {
    world.enemyBlock[world.index(e.tileX, e.tileY)] = 0;
    if (e.targetX >= 0) world.enemyBlock[world.index(e.targetX, e.targetY)] = 0;
    e.targetX = -1;
    e.targetY = -1;
  }

  private stopWalking(world: World, e: Enemy): void {
    if (e.targetX >= 0) {
      world.enemyBlock[world.index(e.targetX, e.targetY)] = 0;
      e.targetX = -1;
      e.targetY = -1;
    }
    e.path.length = 0;
    e.pathIdx = 0;
  }

  update(world: World, player: Player, rng: CarmackRng, sfx: string[]): void {
    for (const e of this.list) {
      if (e.state === ST_DEAD) continue;
      e.stateFrame++;
      const anim = e.behavior.anim;
      switch (e.state) {
        case ST_DYING: {
          const idx = Math.floor(e.stateFrame / anim.dyingStep);
          if (idx >= anim.dying.length) {
            e.state = ST_DEAD;
            e.cell = anim.dead;
          } else e.cell = anim.dying[idx];
          break;
        }
        case ST_HURT: {
          const idx = Math.floor(e.stateFrame / anim.hurtStep);
          if (idx >= anim.hurt.length) {
            e.state = ST_IDLE;
            e.cell = anim.idle[0];
            e.decision = 1;
          } else e.cell = anim.hurt[idx];
          break;
        }
        case ST_ATTACK: {
          const idx = Math.floor(e.stateFrame / anim.attackStep);
          if (e.stateFrame === anim.attackHit) this.resolveAttack(world, e, player, rng);
          if (idx >= anim.attack.length) {
            e.state = ST_IDLE;
            e.cell = anim.idle[0];
            e.decision = e.behavior.reaction + rng.nextInt(10, 14);
          } else e.cell = anim.attack[idx];
          break;
        }
        default: {
          if (e.state === ST_WALK) this.walk(world, e, player, anim);
          else e.cell = anim.idle[0];
          if (--e.decision <= 0) this.decide(world, e, player, rng, sfx);
        }
      }
    }
  }

  private walk(world: World, e: Enemy, player: Player, anim: Anim): void {
    if (e.targetX < 0) {
      // Pick the next path tile; wait if something stands on it.
      if (e.pathIdx >= e.path.length) {
        e.state = ST_IDLE;
        e.cell = anim.idle[0];
        return;
      }
      const next = e.path[e.pathIdx];
      const nx = next % world.w;
      const ny = (next - nx) / world.w;
      const playerThere = player.tileX === nx && player.tileY === ny;
      if (playerThere || world.isSolid(nx, ny, true)) {
        this.stopWalking(world, e);
        e.state = ST_IDLE;
        e.cell = anim.idle[0];
        e.decision = Math.min(e.decision, 12);
        return;
      }
      e.targetX = nx;
      e.targetY = ny;
      world.enemyBlock[next] = 1;
      e.pathIdx++;
    }
    const tx = e.targetX + 0.5;
    const ty = e.targetY + 0.5;
    const dx = tx - e.x;
    const dy = ty - e.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= ENEMY_SPEED) {
      e.x = tx;
      e.y = ty;
      world.enemyBlock[world.index(e.tileX, e.tileY)] = 0;
      e.tileX = e.targetX;
      e.tileY = e.targetY;
      world.enemyBlock[world.index(e.tileX, e.tileY)] = 1;
      e.targetX = -1;
      e.targetY = -1;
    } else {
      e.x += (dx / dist) * ENEMY_SPEED;
      e.y += (dy / dist) * ENEMY_SPEED;
    }
    e.cell = anim.walk[Math.floor(e.stateFrame / anim.walkStep) % anim.walk.length];
  }

  private decide(world: World, e: Enemy, player: Player, rng: CarmackRng, sfx: string[]): void {
    const b = e.behavior;
    e.decision = b.reaction + rng.nextInt(10, 14);
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const dist = Math.hypot(dx, dy);
    const los = !player.dead && dist < SIGHT_RANGE && world.lineOfSight(e.tileX, e.tileY, player.tileX, player.tileY);
    if (!los) {
      if (dist > FORGET_RANGE) e.seen = false;
      // Keep walking a path already under way; otherwise stand.
      if (e.state === ST_WALK && e.pathIdx >= e.path.length && e.targetX < 0) e.state = ST_IDLE;
      if (e.state !== ST_WALK && e.seen) this.startWalk(world, e, player);
      return;
    }
    if (!e.seen) {
      e.seen = true;
      sfx.push(b.alert);
    }
    const inRange = dist >= b.rangeMin && dist <= b.rangeMax;
    let attack = false;
    if (inRange) {
      if (e.kind === KIND_DOG) attack = true;
      else {
        // core/ai.ts getPreferredAttackDistance against Enemy.svelte's roll.
        const units = dist * TILE;
        const preferred = rng.nextInt(Math.floor(units / 2.25), Math.floor(units));
        attack = preferred < units * rng.nextFloat();
      }
      if (e.hurtPending) attack = true;
    }
    e.hurtPending = false;
    if (attack) {
      this.stopWalking(world, e);
      e.state = ST_ATTACK;
      e.stateFrame = 0;
      e.cell = b.anim.attack[0];
      if (b.attack) sfx.push(b.attack);
    } else if (dist > b.rangeMin) {
      this.startWalk(world, e, player);
    } else {
      this.stopWalking(world, e);
      e.state = ST_IDLE;
    }
  }

  private startWalk(world: World, e: Enemy, player: Player): void {
    if (e.targetX >= 0) return; // finish the current step first
    e.path = this.finder.find(e.tileX, e.tileY, player.tileX, player.tileY, this.passable);
    e.pathIdx = 0;
    if (e.path.length === 0) {
      e.state = ST_IDLE;
      return;
    }
    if (e.state !== ST_WALK) e.stateFrame = 0;
    e.state = ST_WALK;
  }

  /** Guard/state.ts setState("attack"): hit chance falls 16 per tile of distance. */
  private resolveAttack(world: World, e: Enemy, player: Player, rng: CarmackRng): void {
    if (player.dead) return;
    const dist = Math.hypot(player.x - e.x, player.y - e.y);
    if (e.kind === KIND_DOG) {
      if (dist > DOG_BITE_RANGE) return;
    } else if (!world.lineOfSight(e.tileX, e.tileY, player.tileX, player.tileY)) return;
    const r1 = rng.nextInt(0, 255);
    const hitChance = 255 - dist * 16;
    if (r1 >= hitChance) return;
    const damage = Math.floor(dist < 2 ? r1 / 4 : dist < 4 ? r1 / 8 : r1 / 16);
    player.takeDamage(damage);
  }

  /** Apply a player's shot. Zero damage is a miss and leaves the enemy alone. */
  damage(world: World, e: Enemy, amount: number, player: Player, rng: CarmackRng, sfx: string[]): void {
    if (!e.alive || amount <= 0) return;
    e.health -= amount;
    if (e.health > 0) {
      this.stopWalking(world, e);
      e.state = ST_HURT;
      e.stateFrame = 0;
      e.cell = e.behavior.anim.hurt[0];
      e.hurtPending = true;
      e.seen = true;
      return;
    }
    this.release(world, e);
    e.state = ST_DYING;
    e.stateFrame = 0;
    e.cell = e.behavior.anim.dying[0];
    player.score += e.behavior.points;
    const deaths = e.behavior.deaths;
    sfx.push(deaths[rng.nextInt(0, deaths.length - 1)]);
    if (e.behavior.drop !== null) this.drop(world, e, e.behavior.drop);
  }

  /** Enemy.svelte drops on the first free neighbour, falling back to the corpse tile. */
  private drop(world: World, e: Enemy, tex: number): void {
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of around) {
      const x = e.tileX + dx;
      const y = e.tileY + dy;
      if (!world.isSolid(x, y, true) && world.doorAt[world.index(x, y)] < 0) {
        world.addObject(x, y, tex);
        return;
      }
    }
    world.addObject(e.tileX, e.tileY, tex);
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }
}
