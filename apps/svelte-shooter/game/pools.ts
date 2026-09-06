// apps/svelte-shooter/game/pools.ts — structure-of-arrays pools.
//
// A slot is bound for life to one pooled host node (and, for bullets and
// enemies, to one texture), so the pools never compact: a kill pushes the
// index back on its kind's free stack and the slot's node is hidden. Spawns
// pop from the stack in O(1) and return -1 when a kind is exhausted — the
// shot is dropped rather than overwriting a live one. Everything is a typed
// array: the per-frame loops allocate nothing.

export interface BulletPool {
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly r: Float32Array;
  readonly age: Float32Array;
  readonly alive: Uint8Array;
  readonly grazed: Uint8Array;
  /** Slot -> kind; constant after creation. */
  readonly kind: Uint8Array;
  readonly kindStart: Int16Array;
  readonly kindCount: Int16Array;
  /** Per-kind stacks of free slots: free[kindStart[k] + j] for j < freeTop[k]. */
  readonly free: Int16Array;
  readonly freeTop: Int16Array;
  count: number;
  /** High-water mark of `count`; the tests size the pools with it. */
  peak: number;
}

function resetBulletStacks(p: BulletPool): void {
  for (let k = 0; k < p.kindCount.length; k++) {
    const start = p.kindStart[k];
    const n = p.kindCount[k];
    p.freeTop[k] = n;
    // Lowest slot pops first.
    for (let j = 0; j < n; j++) p.free[start + j] = start + n - 1 - j;
  }
}

export function createBulletPool(kindSlots: readonly number[]): BulletPool {
  let n = 0;
  for (const c of kindSlots) n += c;
  const kinds = kindSlots.length;
  const kind = new Uint8Array(n);
  const kindStart = new Int16Array(kinds);
  const kindCount = new Int16Array(kinds);
  let at = 0;
  for (let k = 0; k < kinds; k++) {
    kindStart[k] = at;
    kindCount[k] = kindSlots[k];
    kind.fill(k, at, at + kindSlots[k]);
    at += kindSlots[k];
  }
  const p: BulletPool = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    r: new Float32Array(n),
    age: new Float32Array(n),
    alive: new Uint8Array(n),
    grazed: new Uint8Array(n),
    kind,
    kindStart,
    kindCount,
    free: new Int16Array(n),
    freeTop: new Int16Array(kinds),
    count: 0,
    peak: 0,
  };
  resetBulletStacks(p);
  return p;
}

/** Returns the slot, or -1 when every slot of that kind is live. */
export function spawnBullet(
  p: BulletPool,
  kind: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  r: number,
): number {
  const top = p.freeTop[kind];
  if (top === 0) return -1;
  const i = p.free[p.kindStart[kind] + top - 1];
  p.freeTop[kind] = top - 1;
  p.x[i] = x;
  p.y[i] = y;
  p.vx[i] = vx;
  p.vy[i] = vy;
  p.r[i] = r;
  p.age[i] = 0;
  p.alive[i] = 1;
  p.grazed[i] = 0;
  p.count++;
  if (p.count > p.peak) p.peak = p.count;
  return i;
}

export function killBullet(p: BulletPool, i: number): void {
  if (!p.alive[i]) return;
  p.alive[i] = 0;
  const k = p.kind[i];
  p.free[p.kindStart[k] + p.freeTop[k]] = i;
  p.freeTop[k]++;
  p.count--;
}

export function clearBullets(p: BulletPool): void {
  p.alive.fill(0);
  p.count = 0;
  resetBulletStacks(p);
}

export function resetBulletPool(p: BulletPool): void {
  clearBullets(p);
  p.peak = 0;
}

export interface EnemyPool {
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Spawn position: the paths sway around it. */
  readonly x0: Float32Array;
  readonly y0: Float32Array;
  readonly r: Float32Array;
  readonly hp: Int16Array;
  readonly type: Uint8Array;
  readonly alive: Uint8Array;
  readonly path: Uint8Array;
  readonly pattern: Uint8Array;
  readonly age: Float32Array;
  readonly fireCd: Float32Array;
  /** Ring/spiral angle the pattern advances per volley. */
  readonly phase: Float32Array;
  readonly typeStart: Int16Array;
  readonly typeCount: Int16Array;
  readonly free: Int16Array;
  readonly freeTop: Int16Array;
  count: number;
  peak: number;
}

function resetEnemyStacks(p: EnemyPool): void {
  for (let k = 0; k < p.typeCount.length; k++) {
    const start = p.typeStart[k];
    const n = p.typeCount[k];
    p.freeTop[k] = n;
    for (let j = 0; j < n; j++) p.free[start + j] = start + n - 1 - j;
  }
}

export function createEnemyPool(typeSlots: readonly number[], typeR: readonly number[]): EnemyPool {
  let n = 0;
  for (const c of typeSlots) n += c;
  const types = typeSlots.length;
  const type = new Uint8Array(n);
  const r = new Float32Array(n);
  const typeStart = new Int16Array(types);
  const typeCount = new Int16Array(types);
  let at = 0;
  for (let k = 0; k < types; k++) {
    typeStart[k] = at;
    typeCount[k] = typeSlots[k];
    type.fill(k, at, at + typeSlots[k]);
    r.fill(typeR[k], at, at + typeSlots[k]);
    at += typeSlots[k];
  }
  const p: EnemyPool = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    x0: new Float32Array(n),
    y0: new Float32Array(n),
    r,
    hp: new Int16Array(n),
    type,
    alive: new Uint8Array(n),
    path: new Uint8Array(n),
    pattern: new Uint8Array(n),
    age: new Float32Array(n),
    fireCd: new Float32Array(n),
    phase: new Float32Array(n),
    typeStart,
    typeCount,
    free: new Int16Array(n),
    freeTop: new Int16Array(types),
    count: 0,
    peak: 0,
  };
  resetEnemyStacks(p);
  return p;
}

export function spawnEnemy(
  p: EnemyPool,
  type: number,
  x: number,
  y: number,
  path: number,
  pattern: number,
  hp: number,
  fireCd: number,
): number {
  const top = p.freeTop[type];
  if (top === 0) return -1;
  const i = p.free[p.typeStart[type] + top - 1];
  p.freeTop[type] = top - 1;
  p.x[i] = x;
  p.y[i] = y;
  p.x0[i] = x;
  p.y0[i] = y;
  p.hp[i] = hp;
  p.alive[i] = 1;
  p.path[i] = path;
  p.pattern[i] = pattern;
  p.age[i] = 0;
  p.fireCd[i] = fireCd;
  p.phase[i] = 0;
  p.count++;
  if (p.count > p.peak) p.peak = p.count;
  return i;
}

export function killEnemy(p: EnemyPool, i: number): void {
  if (!p.alive[i]) return;
  p.alive[i] = 0;
  const k = p.type[i];
  p.free[p.typeStart[k] + p.freeTop[k]] = i;
  p.freeTop[k]++;
  p.count--;
}

export function clearEnemies(p: EnemyPool): void {
  p.alive.fill(0);
  p.count = 0;
  resetEnemyStacks(p);
}

export function resetEnemyPool(p: EnemyPool): void {
  clearEnemies(p);
  p.peak = 0;
}
