// apps/svelte-shooter/game/rng.ts — seeded xorshift32.
//
// The level is a pure function of (seed, input tape): the sim tests and the
// golden harness replay it frame for frame, so nothing here touches
// Math.random.

export class Rng {
  private s = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    this.s = seed >>> 0 || 0x2545f491;
  }

  nextU32(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x;
  }

  /** [0, 1) */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  pick(n: number): number {
    return this.nextU32() % n;
  }
}
