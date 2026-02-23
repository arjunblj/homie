import { Cron } from 'croner';

import { isInSleepWindow } from '../behavior/timing.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieBehaviorConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionStore } from '../session/types.js';
import type { ChatId } from '../types/ids.js';
import { errorFields, log } from '../util/logger.js';
import { shouldSuppressOutreach } from './heartbeat.js';
import type { EventScheduler } from './scheduler.js';
import type { ProactiveConfig } from './types.js';

export interface GroupCheckInPlannerDeps {
  readonly scheduler: EventScheduler;
  readonly proactiveConfig: ProactiveConfig;
  readonly behaviorConfig: OpenhomieBehaviorConfig;
  readonly memoryStore: MemoryStore;
  readonly sessionStore: SessionStore;
  readonly getLastUserMessageMs?: ((chatId: ChatId) => number | undefined) | undefined;
  readonly timezone?: string | undefined;
  readonly cron?: string | undefined;
  readonly maxEventsPerRun?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly random01?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_CRON = '0 11 * * *';

export class GroupCheckInPlanner {
  private readonly logger = log.child({ component: 'group_checkin_planner' });
  private readonly deps: GroupCheckInPlannerDeps;
  private job: Cron | undefined;

  public constructor(deps: GroupCheckInPlannerDeps) {
    this.deps = deps;
  }

  public start(): void {
    if (this.job) return;
    const timezone = this.deps.timezone ?? this.deps.behaviorConfig.sleep.timezone;
    const expr = (this.deps.cron ?? DEFAULT_CRON).trim() || DEFAULT_CRON;
    this.job = new Cron(expr, { timezone, protect: true }, () => {
      void this.planOnce().catch((err) => {
        this.logger.error('plan_once.failed', errorFields(err));
      });
    });
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

    const maxEvents = Math.max(0, Math.min(5, Math.floor(this.deps.maxEventsPerRun ?? 1)));
    if (maxEvents === 0) return;

    const listChatIds = this.deps.sessionStore.listChatIds?.bind(this.deps.sessionStore);
    if (!listChatIds) return;

    const chatIds = listChatIds(500, 0);
    if (chatIds.length === 0) return;

    const candidates: Array<{ chatId: ChatId; score: number }> = [];
    const minQuietMs = 18 * 60 * 60_000;

    for (const chatId of chatIds) {
      const parsed = parseChatId(chatId);
      if (!parsed || parsed.kind !== 'group') continue;

      const lastUserMessageMs = this.deps.getLastUserMessageMs?.(chatId);
      if (!lastUserMessageMs) continue;
      if (nowMs - lastUserMessageMs < minQuietMs) continue;

      const suppress = shouldSuppressOutreach(
        this.deps.scheduler,
        this.deps.proactiveConfig,
        'check_in',
        chatId,
        lastUserMessageMs,
        undefined,
      );
      if (suppress.suppressed) continue;

      const episodes = await this.deps.memoryStore.countEpisodes(chatId);
      if (episodes < 20) continue;

      const capsule = await this.deps.memoryStore.getGroupCapsule(chatId);
      if (!capsule?.trim()) continue;

      const daysSinceUser = Math.max(0, (nowMs - lastUserMessageMs) / 86_400_000);
      const lullBoost = Math.min(1, daysSinceUser / 14);
      const historyBoost = Math.min(1, episodes / 200);
      const score = 0.75 * lullBoost + 0.25 * historyBoost;
      candidates.push({ chatId, score });
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
        subject: 'group check-in',
        chatId: chosen.chatId,
        triggerAtMs: nowMs + jitter,
        recurrence: 'once',
        createdAtMs: nowMs,
      });
      scheduled += 1;
    }
  }
}
