// One level of Wolfensvelte: the world, the player and the enemies stepped
// together once per host frame. The app owns screens and lives; this class
// owns everything inside the level.

import {
  DEATH_FRAMES,
  KNIFE_RANGE,
  LEVEL_END_FRAMES,
  SHOT_HALF_ANGLE,
  SHOT_RANGE,
  WEAPON_KNIFE,
} from "./constants.ts";
import { EnemyManager } from "./enemies.ts";
import { E1M1, type LevelData } from "./level.ts";
import { Player, type PlayerInput } from "./player.ts";
import { CarmackRng } from "./rng.ts";
import { World } from "./world.ts";

export type GamePhase = "playing" | "dying" | "dead" | "leaving" | "won";

export class Game {
  readonly level: LevelData;
  readonly rng: CarmackRng;
  readonly player = new Player();
  world: World;
  enemies: EnemyManager;
  phase: GamePhase = "playing";
  phaseFrame = 0;
  frame = 0;
  /** Sound names produced this frame; the app drains them. */
  readonly sfx: string[] = [];

  constructor(level: LevelData = E1M1, seed = 0x1a2b3c4d) {
    this.level = level;
    this.rng = new CarmackRng(seed);
    this.world = new World(level);
    this.enemies = new EnemyManager(this.world, level.enemies, this.rng);
    this.player.spawn(level.spawn.x, level.spawn.y, level.spawn.angle, false);
  }

  /** Rebuild the level. `keepScore` restores the level-start score (a respawn). */
  restart(keepScore: boolean): void {
    this.world = new World(this.level);
    this.enemies = new EnemyManager(this.world, this.level.enemies, this.rng);
    this.player.spawn(this.level.spawn.x, this.level.spawn.y, this.level.spawn.angle, keepScore);
    this.phase = "playing";
    this.phaseFrame = 0;
    this.sfx.length = 0;
  }

  private readonly occupied = (x: number, y: number): boolean =>
    (this.player.tileX === x && this.player.tileY === y) || this.world.enemyBlock[this.world.index(x, y)] !== 0;

  update(input: PlayerInput): void {
    this.frame++;
    const { world, player } = this;
    if (this.phase !== "playing") {
      this.phaseFrame++;
      player.update({ ...input, forward: 0, strafe: 0, turn: 0, fire: false, use: false }, world);
      world.update(this.occupied);
      if (this.phase === "dying") {
        this.enemies.update(world, player, this.rng, this.sfx);
        if (this.phaseFrame >= DEATH_FRAMES) this.phase = "dead";
      } else if (this.phase === "leaving" && this.phaseFrame >= LEVEL_END_FRAMES) {
        this.phase = "won";
      }
      this.drain();
      return;
    }

    player.update(input, world);
    if (player.firedThisFrame) this.resolveShot();
    if (input.use) {
      const f = player.facing();
      const result = world.use(player.tileX, player.tileY, f.dx, f.dy, this.occupied);
      if (result === "elevator") {
        this.phase = "leaving";
        this.phaseFrame = 0;
      }
    }
    world.update(this.occupied);
    this.enemies.update(world, player, this.rng, this.sfx);
    if (player.dead) {
      this.phase = "dying";
      this.phaseFrame = 0;
    }
    this.drain();
  }

  private drain(): void {
    for (const s of this.world.sfx) this.sfx.push(s);
    this.world.sfx.length = 0;
    for (const s of this.player.sfx) this.sfx.push(s);
    this.player.sfx.length = 0;
  }

  /** Player.svelte attackClosestEnemy: nearest live enemy inside the aim cone with line of sight. */
  private resolveShot(): void {
    const { player, world } = this;
    const range = player.weapon === WEAPON_KNIFE ? KNIFE_RANGE : SHOT_RANGE;
    let best = null;
    let bestDist = Infinity;
    for (const e of this.enemies.list) {
      if (!e.alive) continue;
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > range || dist >= bestDist) continue;
      let diff = Math.atan2(dy, dx) - player.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > SHOT_HALF_ANGLE) continue;
      if (!world.lineOfSight(player.tileX, player.tileY, e.tileX, e.tileY)) continue;
      best = e;
      bestDist = dist;
    }
    if (!best) return;
    const damage = player.shotDamage(bestDist, this.rng);
    this.enemies.damage(world, best, damage, player, this.rng, this.sfx);
  }
}
