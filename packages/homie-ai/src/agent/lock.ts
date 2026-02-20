export class PerKeyLock<TKey> {
  private readonly chains = new Map<TKey, Promise<void>>();

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

  public get activeCount(): number {
    return this.chains.size;
  }

  public async drain(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }
}
