// Wolfensvelte's utils/engine/rng.ts generator (a 32-bit LCG) with a fixed
// seed, so a sim or golden run replays frame for frame.

export class CarmackRng {
  private seed: number;

  constructor(seed = 0x1a2b3c4d) {
    this.seed = seed >>> 0;
  }

  reseed(seed: number): void {
    this.seed = seed >>> 0;
  }

  /** 0..255 */
  nextByte(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return (this.seed >>> 24) & 0xff;
  }

  /** 0..1 (exclusive) from four bytes, as the original. */
  nextFloat(): number {
    const b1 = this.nextByte();
    const b2 = this.nextByte();
    const b3 = this.nextByte();
    const b4 = this.nextByte();
    const bits = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
    return bits / 4294967295;
  }

  /** Integer in [min, max]. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.nextFloat() * (max - min + 1)) + min;
  }
}
