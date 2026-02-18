import { isInSleepWindow } from '../behavior/timing.js';
import type { HomieBehaviorConfig } from '../config/types.js';
import type { ChatId } from '../types/ids.js';
import { IntervalLoop } from '../util/intervalLoop.js';
import { errorFields, log, newCorrelationId } from '../util/logger.js';
import type { EventScheduler } from './scheduler.js';
import type { ProactiveConfig, ProactiveEvent } from './types.js';

export interface HeartbeatDeps {
  readonly scheduler: EventScheduler;
  readonly proactiveConfig: ProactiveConfig;
  readonly behaviorConfig: HomieBehaviorConfig;
  readonly getLastUserMessageMs?: (chatId: ChatId) => number | undefined;
  readonly onProactive: (event: ProactiveEvent) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}

const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 604_800_000;

export function shouldSuppressOutreach(
  scheduler: EventScheduler,
  config: ProactiveConfig,
  chatId: ChatId,
  lastUserMessageMs: number | undefined,
): { suppressed: boolean; reason?: string } {
  const now = Date.now();

  if (lastUserMessageMs && now - lastUserMessageMs < config.cooldownAfterUserMs) {
    return { suppressed: true, reason: 'cooldown_after_user' };
  }

  const dailySends = scheduler.countRecentSends(ONE_DAY_MS);
  if (dailySends >= config.maxPerDay) {
    return { suppressed: true, reason: 'max_per_day' };
  }

  const weeklySends = scheduler.countRecentSends(ONE_WEEK_MS);
  if (weeklySends >= config.maxPerWeek) {
    return { suppressed: true, reason: 'max_per_week' };
  }

  const ignored = scheduler.countIgnoredRecent(chatId, config.pauseAfterIgnored);
  if (ignored >= config.pauseAfterIgnored) {
    return { suppressed: true, reason: 'ignored_pause' };
  }

  return { suppressed: false };
}

export class HeartbeatLoop {
  private readonly logger = log.child({ component: 'heartbeat' });
  private loop: IntervalLoop | undefined;
  private readonly deps: HeartbeatDeps;
  private readonly claimId = `heartbeat:${newCorrelationId()}`;

  public constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  public start(): void {
    const interval = this.deps.proactiveConfig.heartbeatIntervalMs;
    if (this.loop) return;
    this.loop = new IntervalLoop({
      name: 'heartbeat',
      everyMs: interval,
      tick: async () => this.tick(),
      signal: this.deps.signal,
    });
    this.loop.start();
  }

  public stop(): void {
    this.loop?.stop();
    this.loop = undefined;
  }

  public async tick(): Promise<void> {
    const { scheduler, proactiveConfig, behaviorConfig } = this.deps;

    if (!proactiveConfig.enabled) return;

    if (isInSleepWindow(new Date(), behaviorConfig.sleep)) return;

    // Only deliver events when they're due (never early).
    // This may deliver slightly late (up to the loop interval), which is safer than early sends.
    const pending = scheduler.claimPendingEvents({
      windowMs: 0,
      limit: 50,
      leaseMs: 10 * 60_000,
      claimId: this.claimId,
    });

    for (const event of pending) {
      try {
        const lastUserMessageMs = this.deps.getLastUserMessageMs?.(event.chatId);
        const { suppressed } = shouldSuppressOutreach(
          scheduler,
          proactiveConfig,
          event.chatId,
          lastUserMessageMs,
        );
        if (suppressed) {
          scheduler.releaseClaim(event.id, this.claimId);
          continue;
        }

        const sent = await this.deps.onProactive(event);
        if (!sent) {
          scheduler.releaseClaim(event.id, this.claimId);
          continue;
        }

        scheduler.markDelivered(event.id, this.claimId);
        scheduler.logProactiveSend(event.chatId, event.id);
      } catch (err) {
        scheduler.releaseClaim(event.id, this.claimId);
        this.logger.error('event.failed', { ...errorFields(err), chatId: String(event.chatId) });
      }
    }
  }

  public healthCheck(): void {
    this.loop?.healthCheck();
  }
}
