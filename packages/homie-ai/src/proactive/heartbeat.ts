import type { LLMBackend } from '../backend/types.js';
import { isInSleepWindow } from '../behavior/timing.js';
import type { HomieBehaviorConfig } from '../config/types.js';
import type { ChatId } from '../types/ids.js';
import type { EventScheduler } from './scheduler.js';
import type { ProactiveConfig, ProactiveEvent } from './types.js';

export interface HeartbeatDeps {
  readonly backend: LLMBackend;
  readonly scheduler: EventScheduler;
  readonly proactiveConfig: ProactiveConfig;
  readonly behaviorConfig: HomieBehaviorConfig;
  readonly onSend: (chatId: ChatId, text: string) => Promise<void>;
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

function formatEventMessage(event: ProactiveEvent): string {
  switch (event.kind) {
    case 'birthday':
      return `Hey, just wanted to remind you — ${event.subject} is coming up!`;
    case 'reminder':
      return `Reminder: ${event.subject}`;
    case 'follow_up':
      return event.subject;
    case 'check_in':
      return event.subject;
  }
}

export class HeartbeatLoop {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly deps: HeartbeatDeps;

  public constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  public start(): void {
    if (this.timer) return;
    const interval = this.deps.proactiveConfig.heartbeatIntervalMs;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // Heartbeat errors are non-fatal
      });
    }, interval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async tick(): Promise<void> {
    const { scheduler, proactiveConfig, behaviorConfig } = this.deps;

    if (!proactiveConfig.enabled) return;

    if (isInSleepWindow(new Date(), behaviorConfig.sleep)) return;

    const pending = scheduler.getPendingEvents(proactiveConfig.heartbeatIntervalMs);

    for (const event of pending) {
      const { suppressed } = shouldSuppressOutreach(
        scheduler,
        proactiveConfig,
        event.chatId,
        undefined,
      );
      if (suppressed) continue;

      const message = formatEventMessage(event);
      await this.deps.onSend(event.chatId, message);
      scheduler.markDelivered(event.id);
      scheduler.logProactiveSend(event.chatId);
    }
  }
}
