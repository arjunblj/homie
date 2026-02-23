import { Cron } from 'croner';

import { isInSleepWindow } from '../behavior/timing.js';
import type { OpenhomieBehaviorConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { PersonRecord } from '../memory/types.js';
import { deriveTrustTierForPerson } from '../memory/types.js';
import type { ChatId } from '../types/ids.js';
import { asChatId } from '../types/ids.js';
import { errorFields, log } from '../util/logger.js';
import { shouldSuppressOutreach } from './heartbeat.js';
import type { EventScheduler } from './scheduler.js';
import type { ProactiveConfig } from './types.js';

export interface CheckInPlannerDeps {
  readonly scheduler: EventScheduler;
  readonly proactiveConfig: ProactiveConfig;
  readonly behaviorConfig: OpenhomieBehaviorConfig;
  readonly memoryStore: MemoryStore;
  readonly getLastUserMessageMs?: ((chatId: ChatId) => number | undefined) | undefined;
  readonly timezone?: string | undefined;
  readonly cron?: string | undefined;
  readonly maxEventsPerRun?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly random01?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_CRON = '0 10 * * *';

const channelUserIdToDmChatId = (channelUserId: string): ChatId | null => {
  const s = String(channelUserId);
  if (s.startsWith('telegram:')) {
    const id = s.slice('telegram:'.length);
    return id ? asChatId(`tg:${id}`) : null;
  }
  if (s.startsWith('signal:')) {
    const id = s.slice('signal:'.length);
    return id ? asChatId(`signal:dm:${id}`) : null;
  }
  return null;
};

const stableCandidateScore = (opts: {
  relationshipScore: number;
  lastUserMessageMs: number;
  nowMs: number;
}): number => {
  const daysSinceUser = Math.max(0, (opts.nowMs - opts.lastUserMessageMs) / 86_400_000);
  const recencyBoost = Math.min(1, daysSinceUser / 30);
  return opts.relationshipScore + recencyBoost;
};

export class CheckInPlanner {
  private readonly logger = log.child({ component: 'checkin_planner' });
  private readonly deps: CheckInPlannerDeps;
  private job: Cron | undefined;

  public constructor(deps: CheckInPlannerDeps) {
    this.deps = deps;
  }

  public start(): void {
    if (this.job) return;
    const timezone = this.deps.timezone ?? this.deps.behaviorConfig.sleep.timezone;
    const expr = (this.deps.cron ?? DEFAULT_CRON).trim() || DEFAULT_CRON;
    this.job = new Cron(
      expr,
      {
        timezone,
        protect: true,
      },
      () => {
        void this.planOnce().catch((err) => {
          this.logger.error('plan_once.failed', errorFields(err));
        });
      },
    );
  }

  public stop(): void {
    this.job?.stop();
    this.job = undefined;
  }

  public async planOnce(): Promise<void> {
    const nowMs = this.deps.nowMs?.() ?? Date.now();
    if (!this.deps.proactiveConfig.enabled) return;
    if (this.deps.signal?.aborted) return;
    if (isInSleepWindow(new Date(nowMs), this.deps.behaviorConfig.sleep)) return;

    const maxEvents = Math.max(0, Math.min(10, Math.floor(this.deps.maxEventsPerRun ?? 1)));
    if (maxEvents === 0) return;

    const people = await this.deps.memoryStore.listPeople(500, 0);
    if (people.length === 0) return;

    const candidates: Array<{
      person: PersonRecord;
      chatId: ChatId;
      score: number;
    }> = [];

    for (const person of people) {
      const trust = deriveTrustTierForPerson(person);
      if (trust === 'new_contact') continue;

      const chatId = channelUserIdToDmChatId(person.channelUserId);
      if (!chatId) continue;

      const lastUserMessageMs = this.deps.getLastUserMessageMs?.(chatId);
      if (!lastUserMessageMs) continue;

      // Only consider check-ins after meaningful silence.
      const minQuietDays = trust === 'close_friend' ? 7 : 14;
      if (nowMs - lastUserMessageMs < minQuietDays * 86_400_000) continue;

      // Avoid scheduling if they've only interacted once or twice.
      const episodes = await this.deps.memoryStore.countEpisodes(chatId);
      if (episodes < 3) continue;

      const suppress = shouldSuppressOutreach(
        this.deps.scheduler,
        this.deps.proactiveConfig,
        'check_in',
        chatId,
        lastUserMessageMs,
        trust,
      );
      if (suppress.suppressed) continue;

      candidates.push({
        person,
        chatId,
        score: stableCandidateScore({
          relationshipScore: person.relationshipScore,
          lastUserMessageMs,
          nowMs,
        }),
      });
    }

    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.score - a.score);

    const rand01 = this.deps.random01 ?? Math.random;

    const remaining = candidates.slice(0, 10);
    let scheduled = 0;

    const jitterMinMs = 5 * 60_000;
    const jitterMaxMs = 45 * 60_000;
    while (scheduled < maxEvents && remaining.length > 0) {
      if (this.deps.signal?.aborted) return;
      const idx = Math.floor(rand01() * remaining.length);
      const chosen = remaining.splice(idx, 1)[0] ?? remaining[0];
      if (!chosen) break;

      const jitter = jitterMinMs + Math.floor(rand01() * (jitterMaxMs - jitterMinMs + 1));
      this.deps.scheduler.addEvent({
        kind: 'check_in',
        subject: `Check in: ${chosen.person.displayName}`,
        chatId: chosen.chatId,
        triggerAtMs: nowMs + jitter,
        recurrence: 'once',
        createdAtMs: nowMs,
      });
      scheduled += 1;
    }
  }
}
