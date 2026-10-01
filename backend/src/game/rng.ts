import { createHash } from 'node:crypto';

/**
 * Seeded randomness (mulberry32). Analyst reads and talent pools are
 * derived from stable seeds, so re-running an analysis or reloading the
 * pool gives the same result — there is nothing to farm by retrying.
 */
export class Rng {
  private state: number;

  constructor(seed: string) {
    this.state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Index drawn in proportion to non-negative weights. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]!);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  normal(mean: number, sd: number): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}
