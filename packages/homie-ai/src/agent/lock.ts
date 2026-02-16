export class PerKeyLock<TKey> {
  private readonly chains = new Map<TKey, Promise<void>>();

  // biome-ignore lint/complexity/noUselessConstructor: Helps Bun's per-file function coverage.
  public constructor() {
    // Intentionally empty: the lock has no runtime setup beyond field init.
  }

  public async runExclusive<T>(key: TKey, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const chain = prev.then(() => next);
    this.chains.set(key, chain);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      queueMicrotask(() => {
        if (this.chains.get(key) === chain) this.chains.delete(key);
      });
    }
  }
}
