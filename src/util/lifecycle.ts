import { errorFields, log } from './logger.js';

export interface Stoppable {
  stop(): void | Promise<void>;
}

export class Lifecycle {
  private readonly logger = log.child({ component: 'lifecycle' });
  private readonly controller = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private lastSuccessfulTurnMs: number | null = null;

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public markSuccessfulTurn(): void {
    this.lastSuccessfulTurnMs = Date.now();
  }

  public getLastSuccessfulTurnMs(): number | null {
    return this.lastSuccessfulTurnMs;
  }

  public track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise as Promise<unknown>);
    promise.finally(() => this.inflight.delete(promise as Promise<unknown>));
    return promise;
  }

  public async drain(timeoutMs = 10_000): Promise<void> {
    if (this.inflight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ]);
  }

  public async shutdown(options: {
    reason?: string | undefined;
    stop?: readonly Stoppable[] | undefined;
    drain?: readonly (() => Promise<void>)[] | undefined;
    drainTimeoutMs?: number | undefined;
    close?: readonly (() => void)[] | undefined;
  }): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Stop accepting new work.
    for (const s of options.stop ?? []) {
      try {
        await s.stop();
      } catch (err) {
        // Best-effort.
        this.logger.debug('stop.failed', errorFields(err));
      }
    }

    // Cancel any in-flight work that honors abort signals.
    this.controller.abort(options.reason ?? 'shutdown');

    // Drain harness work (turns, background extractors).
    for (const d of options.drain ?? []) {
      try {
        await d();
      } catch (err) {
        // Best-effort.
        this.logger.debug('drain.failed', errorFields(err));
      }
    }
    await this.drain(options.drainTimeoutMs ?? 10_000);

    // Close resources.
    for (const c of options.close ?? []) {
      try {
        c();
      } catch (err) {
        // Best-effort.
        this.logger.debug('close.failed', errorFields(err));
      }
    }
  }
}
