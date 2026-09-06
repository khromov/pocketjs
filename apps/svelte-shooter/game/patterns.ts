// apps/svelte-shooter/game/patterns.ts — bullet emitters.
//
// Pure functions over a bullet pool: numbers in, spawns out, no allocation.
// Angles are radians with +x right and +y down, so "toward the player" from
// above is about PI/2.

import { KIND_R } from "./constants.ts";
import { spawnBullet, type BulletPool } from "./pools.ts";

export const TAU = Math.PI * 2;

export function angleTo(x: number, y: number, tx: number, ty: number): number {
  return Math.atan2(ty - y, tx - x);
}

export function emit(p: BulletPool, kind: number, x: number, y: number, angle: number, speed: number): void {
  spawnBullet(p, kind, x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, KIND_R[kind]);
}

export function fireAimed(
  p: BulletPool,
  x: number,
  y: number,
  tx: number,
  ty: number,
  speed: number,
  kind: number,
): void {
  emit(p, kind, x, y, angleTo(x, y, tx, ty), speed);
}

/** `count` bullets spread evenly across `spread` radians centred on `angle`. */
export function fireFan(
  p: BulletPool,
  x: number,
  y: number,
  angle: number,
  count: number,
  spread: number,
  speed: number,
  kind: number,
): void {
  if (count <= 1) {
    emit(p, kind, x, y, angle, speed);
    return;
  }
  const step = spread / (count - 1);
  let a = angle - spread / 2;
  for (let i = 0; i < count; i++) {
    emit(p, kind, x, y, a, speed);
    a += step;
  }
}

export function fireRing(
  p: BulletPool,
  x: number,
  y: number,
  count: number,
  speed: number,
  phase: number,
  kind: number,
): void {
  const step = TAU / count;
  for (let i = 0; i < count; i++) emit(p, kind, x, y, phase + i * step, speed);
}

/** One bullet per arm; the caller advances `angle` between volleys. */
export function fireSpiral(
  p: BulletPool,
  x: number,
  y: number,
  angle: number,
  arms: number,
  speed: number,
  kind: number,
): void {
  const step = TAU / arms;
  for (let i = 0; i < arms; i++) emit(p, kind, x, y, angle + i * step, speed);
}

/**
 * True once per `period` ticks: when the step from `t - dt` to `t` crossed a
 * multiple of the period (offset by `offset`). Robust to dt > 1.
 */
export function due(t: number, dt: number, period: number, offset = 0): boolean {
  const now = t - offset;
  if (now < 0) return false;
  return Math.floor(now / period) !== Math.floor((now - dt) / period);
}
