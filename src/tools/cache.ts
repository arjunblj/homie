export type NowMs = () => number;

type Entry<T> = {
  value: T;
  expiresAtMs: number;
};

const defaultNowMs: NowMs = () => Date.now();

export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();
  private readonly nowMs: NowMs;
  private readonly maxKeys: number;

  public constructor(opts: { maxKeys: number; nowMs?: NowMs | undefined }) {
    if (!Number.isFinite(opts.maxKeys) || opts.maxKeys < 0) {
      throw new Error('TtlCache: maxKeys must be a finite number >= 0');
    }
    this.maxKeys = Math.floor(opts.maxKeys);
    this.nowMs = opts.nowMs ?? defaultNowMs;
  }

  public get size(): number {
    return this.map.size;
  }

  public clear(): void {
    this.map.clear();
  }

  public get(key: string): T | undefined {
    const now = this.nowMs();
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAtMs <= now) {
      this.map.delete(key);
      return undefined;
    }

    // Refresh insertion order for simple LRU behavior.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  public set(key: string, value: T, ttlMs: number): void {
    if (this.maxKeys === 0) return;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('TtlCache.set: ttlMs must be a finite number >= 0');
    }
    if (ttlMs === 0) {
      this.map.delete(key);
      return;
    }

    const now = this.nowMs();
    const expiresAtMs = now + Math.max(1, Math.floor(ttlMs));
    const e: Entry<T> = { value, expiresAtMs };
    this.map.delete(key);
    this.map.set(key, e);

    this.evictExpired(now);
    this.evictToMaxKeys();
  }

  private evictExpired(nowMs: number): void {
    for (const [k, v] of this.map) {
      if (v.expiresAtMs <= nowMs) this.map.delete(k);
    }
  }

  private evictToMaxKeys(): void {
    while (this.map.size > this.maxKeys) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      this.map.delete(oldest.value);
    }
  }
}
