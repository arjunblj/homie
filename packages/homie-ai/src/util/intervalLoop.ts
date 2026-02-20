import { errorFields, log } from './logger.js';

export interface IntervalLoopOptions {
  readonly name: string;
  readonly everyMs: number;
  readonly tick: (nowMs: number) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}

export class IntervalLoop {
  private readonly logger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private abortListener: (() => void) | undefined;

  private lastOkAtMs: number | undefined;
  private lastErrorAtMs: number | undefined;

  public constructor(private readonly options: IntervalLoopOptions) {
    this.logger = log.child({ component: 'loop', loop: options.name });
  }

  public start(): void {
    if (this.timer) return;
    if (this.options.signal?.aborted) return;

    if (this.options.signal && !this.abortListener) {
      this.abortListener = () => this.stop();
      this.options.signal.addEventListener('abort', this.abortListener, { once: true });
    }

    const everyMs = Math.max(250, this.options.everyMs);
    // Treat start as "fresh" until the first tick completes.
    this.lastOkAtMs = Date.now();
    this.lastErrorAtMs = undefined;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, everyMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.abortListener && this.options.signal) {
      this.options.signal.removeEventListener('abort', this.abortListener);
      this.abortListener = undefined;
    }
  }

  public healthCheck(opts?: { staleAfterMs?: number | undefined }): void {
    const staleAfterMs = opts?.staleAfterMs ?? this.options.everyMs * 3;
    if (!this.timer) throw new Error(`${this.options.name} loop not running`);
    const lastOk = this.lastOkAtMs ?? 0;
    if (Date.now() - lastOk > staleAfterMs) {
      throw new Error(`${this.options.name} loop stale`);
    }
    const lastErr = this.lastErrorAtMs;
    if (lastErr && Date.now() - lastErr < staleAfterMs) {
      throw new Error(`${this.options.name} loop recently errored`);
    }
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    if (this.options.signal?.aborted) return;
    this.inFlight = true;
    const started = Date.now();
    try {
      await this.options.tick(started);
      this.lastOkAtMs = Date.now();
      this.logger.debug('tick.ok', { ms: Date.now() - started });
    } catch (err) {
      this.lastErrorAtMs = Date.now();
      this.logger.error('tick.error', { ms: Date.now() - started, ...errorFields(err) });
    } finally {
      this.inFlight = false;
    }
  }
}
