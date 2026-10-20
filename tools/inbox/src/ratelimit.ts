// Sliding-window rate limit per key: at most `limit` hits in any `windowMs`. In memory only;
// a restart forgets it, which at worst allows one more burst.

export class RateLimiter {
  private hits = new Map<string, number[]>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Counts a hit. Returns 0 if allowed, else the ms until the next hit would be. */
  hit(key: string, now: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return list[0]! + this.windowMs - now;
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}
