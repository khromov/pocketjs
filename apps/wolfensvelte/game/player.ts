// The player: movement with tile collision, weapons and vitals. Port of
// stores/player.ts plus the input half of Player.svelte.

import {
  KNIFE_COOLDOWN,
  MOVE_SPEED,
  PISTOL_COOLDOWN,
  PLAYER_RADIUS,
  SMG_COOLDOWN,
  TURN_SPEED,
  WEAPON_KNIFE,
  WEAPON_PISTOL,
  WEAPON_SMG,
} from "./constants.ts";
import type { CarmackRng } from "./rng.ts";
import {
  PICKUP_AMMO,
  PICKUP_CHEST,
  PICKUP_CROSS,
  PICKUP_CROWN,
  PICKUP_DOGFOOD,
  PICKUP_FOOD,
  PICKUP_GOBLET,
  PICKUP_MEDKIT,
  PICKUP_SMG,
  type World,
} from "./world.ts";

export interface PlayerInput {
  /** -1..1, positive = forward. */
  forward: number;
  /** -1..1, positive = strafe right. */
  strafe: number;
  /** -1..1, positive = turn right (clockwise on screen). */
  turn: number;
  /** Fire held this frame. */
  fire: boolean;
  /** Use pressed this frame (edge). */
  use: boolean;
  nextWeapon: boolean;
  prevWeapon: boolean;
  /** -1, or a weapon index to select directly. */
  selectWeapon: number;
}

export const EMPTY_INPUT: PlayerInput = {
  forward: 0, strafe: 0, turn: 0, fire: false, use: false, nextWeapon: false, prevWeapon: false, selectWeapon: -1,
};

// utils/engine/objects.ts TreasurePickupPointMap
const TREASURE_POINTS: Record<number, number> = {
  [PICKUP_CROSS]: 100,
  [PICKUP_GOBLET]: 500,
  [PICKUP_CHEST]: 1000,
  [PICKUP_CROWN]: 5000,
};

// Hand animation cells per weapon: frame index into hand-<weapon>-N.png and
// how many host frames each is held (Player.svelte's `shooting` keyframes).
const HAND_PISTOL: readonly number[] = [1, 2, 3];
const HAND_PISTOL_HOLD = 8;
const HAND_SMG: readonly number[] = [1, 2, 3, 4];
const HAND_SMG_HOLD = 2;

export class Player {
  x = 0;
  y = 0;
  angle = 0;
  health = 100;
  ammo = 8;
  score = 0;
  weapon = WEAPON_PISTOL;
  hasSmg = false;
  /** Frames until the next shot may fire. */
  cooldown = 0;
  /** Current hand frame (0 = at rest) and frames left on it. */
  handFrame = 0;
  private handQueue: number[] = [];
  private handHold = 0;
  /** Damage flash intensity 0..1, decays per frame. */
  flash = 0;
  /** Score at level start, restored on respawn (stores/player.ts init(..., dead)). */
  levelStartScore = 0;
  /** Set when a shot is fired this frame; the game resolves the hit. */
  firedThisFrame = false;
  /** Sound names queued this frame. */
  readonly sfx: string[] = [];

  get dead(): boolean {
    return this.health <= 0;
  }

  get tileX(): number {
    return Math.floor(this.x);
  }

  get tileY(): number {
    return Math.floor(this.y);
  }

  /** DEFAULT_STATE: 100 health, 8 rounds, pistol, knife + pistol owned. */
  spawn(x: number, y: number, angle: number, keepScore: boolean): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.health = 100;
    this.ammo = 8;
    this.weapon = WEAPON_PISTOL;
    this.hasSmg = false;
    this.cooldown = 0;
    this.handFrame = 0;
    this.handQueue.length = 0;
    this.handHold = 0;
    this.flash = 0;
    this.firedThisFrame = false;
    if (keepScore) this.score = this.levelStartScore;
    else {
      this.score = 0;
      this.levelStartScore = 0;
    }
  }

  /** The cardinal direction the player faces, for the use action. */
  facing(): { dx: number; dy: number } {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return Math.abs(c) >= Math.abs(s) ? { dx: c > 0 ? 1 : -1, dy: 0 } : { dx: 0, dy: s > 0 ? 1 : -1 };
  }

  private canStand(world: World, x: number, y: number): boolean {
    const r = PLAYER_RADIUS;
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r);
    const y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (world.isSolid(tx, ty, true)) return false;
      }
    }
    return true;
  }

  /** Turn, move (sliding along walls), collect pickups, tick timers. */
  update(input: PlayerInput, world: World): void {
    this.firedThisFrame = false;
    if (this.cooldown > 0) this.cooldown--;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.04);
    this.tickHand();
    if (this.dead) return;

    if (input.turn !== 0) {
      this.angle += input.turn * TURN_SPEED;
      if (this.angle > Math.PI) this.angle -= Math.PI * 2;
      else if (this.angle < -Math.PI) this.angle += Math.PI * 2;
    }
    if (input.forward !== 0 || input.strafe !== 0) {
      const c = Math.cos(this.angle);
      const s = Math.sin(this.angle);
      let mx = c * input.forward - s * input.strafe;
      let my = s * input.forward + c * input.strafe;
      const len = Math.hypot(mx, my);
      if (len > 1) {
        mx /= len;
        my /= len;
      }
      const nx = this.x + mx * MOVE_SPEED;
      const ny = this.y + my * MOVE_SPEED;
      if (this.canStand(world, nx, this.y)) this.x = nx;
      if (this.canStand(world, this.x, ny)) this.y = ny;
      this.collect(world);
    }

    if (input.selectWeapon >= 0) this.selectWeapon(input.selectWeapon);
    else if (input.nextWeapon) this.cycleWeapon(1);
    else if (input.prevWeapon) this.cycleWeapon(-1);

    if (input.fire && this.cooldown === 0) this.fire();
  }

  private collect(world: World): void {
    const item = world.pickupAt(this.tileX, this.tileY);
    if (!item) return;
    // Level.svelte handleNoClipObject: full health/ammo still consumes the item.
    switch (item.tex) {
      case PICKUP_SMG:
        this.giveWeapon(WEAPON_SMG);
        break;
      case PICKUP_AMMO:
        this.ammo += 4;
        break;
      case PICKUP_DOGFOOD:
        this.giveHealth(4);
        break;
      case PICKUP_FOOD:
        this.giveHealth(10);
        break;
      case PICKUP_MEDKIT:
        this.giveHealth(25);
        break;
      default: {
        const points = TREASURE_POINTS[item.tex];
        if (points) this.score += points;
      }
    }
    world.removeObject(item);
  }

  giveHealth(n: number): void {
    this.health = Math.min(100, this.health + n);
  }

  giveWeapon(weapon: number): void {
    if (weapon === WEAPON_SMG) {
      if (this.hasSmg) this.ammo += 4;
      else this.hasSmg = true;
    }
  }

  takeDamage(n: number): void {
    if (n <= 0 || this.dead) return;
    this.health = Math.max(0, this.health - n);
    this.flash = Math.min(1, 0.35 + n / 40);
  }

  owns(weapon: number): boolean {
    return weapon === WEAPON_SMG ? this.hasSmg : true;
  }

  selectWeapon(weapon: number): void {
    if (weapon >= WEAPON_KNIFE && weapon <= WEAPON_SMG && this.owns(weapon)) this.weapon = weapon;
  }

  cycleWeapon(dir: number): void {
    for (let i = 1; i <= 2; i++) {
      const w = (this.weapon + dir * i + 3) % 3;
      if (this.owns(w)) {
        this.weapon = w;
        return;
      }
    }
  }

  private fire(): void {
    if (this.weapon !== WEAPON_KNIFE) {
      if (this.ammo <= 0) return;
      this.ammo--;
      this.sfx.push(this.weapon === WEAPON_SMG ? "smg" : "pistol");
    }
    this.cooldown = this.weapon === WEAPON_SMG ? SMG_COOLDOWN : this.weapon === WEAPON_PISTOL ? PISTOL_COOLDOWN : KNIFE_COOLDOWN;
    this.firedThisFrame = true;
    if (this.weapon === WEAPON_PISTOL) this.playHand(HAND_PISTOL, HAND_PISTOL_HOLD);
    else if (this.weapon === WEAPON_SMG) this.playHand(HAND_SMG, HAND_SMG_HOLD);
  }

  private playHand(frames: readonly number[], hold: number): void {
    this.handQueue = frames.slice();
    this.handFrame = this.handQueue.shift()!;
    this.handHold = hold;
    this.handHoldBase = hold;
  }

  private handHoldBase = 0;

  private tickHand(): void {
    if (this.handFrame === 0) return;
    if (--this.handHold > 0) return;
    if (this.handQueue.length > 0) {
      this.handFrame = this.handQueue.shift()!;
      this.handHold = this.handHoldBase;
    } else {
      this.handFrame = 0;
    }
  }

  /**
   * Damage dealt to an enemy `distance` tiles away (stores/player.ts attack()).
   * Beyond four tiles a shot can miss outright; nearer ones land for r2/4 or r2/6.
   */
  shotDamage(distance: number, rng: CarmackRng): number {
    const r1 = rng.nextInt(0, 255);
    const r2 = rng.nextInt(0, 255);
    if (distance > 4 && r1 / 12 < distance) return 0;
    return distance < 2 ? r2 / 4 : r2 / 6;
  }
}
