import { isInSleepWindow } from '../behavior/timing.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieBehaviorConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import { type ChatTrustTier, deriveTrustTierForPerson } from '../memory/types.js';
import type { OutboundLedger } from '../session/outbound-ledger.js';
import type { ChatId } from '../types/ids.js';
import { IntervalLoop } from '../util/intervalLoop.js';
import { errorFields, log, newCorrelationId } from '../util/logger.js';
import type { EventScheduler } from './scheduler.js';
import type { EventKind, ProactiveConfig, ProactiveEvent } from './types.js';

export interface HeartbeatDeps {
  readonly scheduler: EventScheduler;
  readonly proactiveConfig: ProactiveConfig;
  readonly behaviorConfig: OpenhomieBehaviorConfig;
  readonly memoryStore?: MemoryStore | undefined;
  readonly outboundLedger?: OutboundLedger | undefined;
  readonly getLastUserMessageMs?: (chatId: ChatId) => number | undefined;
  readonly onProactive: (event: ProactiveEvent) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}

const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 604_800_000;
const SKIP_BUCKET_MS = 6 * 60 * 60_000;

const fnv1a32 = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
const stableChance01 = (seed: string): number => fnv1a32(seed) / 2 ** 32;
const skipRoll01 = (eventId: number, nowMs: number): number => {
  const bucket = Math.floor(nowMs / SKIP_BUCKET_MS);
  return stableChance01(`proactive-skip:${eventId}:${bucket}`);
};
const skipDeferMs = (eventId: number, nowMs: number): number => {
  const bucket = Math.floor(nowMs / SKIP_BUCKET_MS);
  const w = stableChance01(`proactive-skip-jitter:${eventId}:${bucket}`);
  const min = 30 * 60_000;
  const max = SKIP_BUCKET_MS;
  return Math.max(min, Math.min(max, min + Math.floor(w * (max - min))));
};

const TIER_CADENCE: Record<ChatTrustTier, { minIntervalMs: number }> = {
  close_friend: { minIntervalMs: 5 * ONE_DAY_MS },
  established: { minIntervalMs: 14 * ONE_DAY_MS },
  getting_to_know: { minIntervalMs: 30 * ONE_DAY_MS },
  new_contact: { minIntervalMs: 60 * ONE_DAY_MS },
};

export function shouldSuppressOutreach(
  scheduler: EventScheduler,
  config: ProactiveConfig,
  eventKind: EventKind,
  chatId: ChatId,
  lastUserMessageMs: number | undefined,
  trustTier?: ChatTrustTier | undefined,
): { suppressed: boolean; reason?: string; nextAttemptAtMs?: number } {
  const now = Date.now();
  const isGroup = parseChatId(chatId)?.kind === 'group';
  const limits = isGroup ? config.group : config.dm;

  // Reminders are user-intentful and should not be rate-limited away.
  if (eventKind === 'reminder') return { suppressed: false };

  if (!isGroup && trustTier) {
    const minIntervalMs = TIER_CADENCE[trustTier].minIntervalMs;
    const lastSendMs = scheduler.lastSendMsForChat?.(chatId);
    if (lastSendMs && now - lastSendMs < minIntervalMs) {
      return {
        suppressed: true,
        reason: 'tier_cadence',
        nextAttemptAtMs: lastSendMs + minIntervalMs,
      };
    }
  }

  if (lastUserMessageMs && now - lastUserMessageMs < limits.cooldownAfterUserMs) {
    return {
      suppressed: true,
      reason: 'cooldown_after_user',
      nextAttemptAtMs: lastUserMessageMs + limits.cooldownAfterUserMs,
    };
  }

  const dailySends = scheduler.countRecentSendsForScope(isGroup, ONE_DAY_MS);
  if (dailySends >= limits.maxPerDay) {
    return { suppressed: true, reason: 'max_per_day', nextAttemptAtMs: now + 3 * 60 * 60_000 };
  }

  const weeklySends = scheduler.countRecentSendsForScope(isGroup, ONE_WEEK_MS);
  if (weeklySends >= limits.maxPerWeek) {
    return { suppressed: true, reason: 'max_per_week', nextAttemptAtMs: now + 12 * 60 * 60_000 };
  }

  if (isGroup) {
    const perChatDaily = scheduler.countRecentSendsForChat(chatId, ONE_DAY_MS);
    if (perChatDaily >= limits.maxPerDay)
      return {
        suppressed: true,
        reason: 'group_max_per_day',
        nextAttemptAtMs: now + 6 * 60 * 60_000,
      };

    const perChatWeekly = scheduler.countRecentSendsForChat(chatId, ONE_WEEK_MS);
    if (perChatWeekly >= limits.maxPerWeek)
      return {
        suppressed: true,
        reason: 'group_max_per_week',
        nextAttemptAtMs: now + 12 * 60 * 60_000,
      };
  }

  // Exponential backoff: each consecutive ignored message doubles the pause threshold.
  // After 1 ignored: need 1 to suppress. After 2: need 2. After 3: need 3.
  // But the cooldown period between attempts grows exponentially (2^n * base).
  const lookback = Math.min(20, limits.pauseAfterIgnored * 4);
  const consecutiveIgnored = scheduler.countIgnoredRecent(chatId, lookback);
  if (consecutiveIgnored >= limits.pauseAfterIgnored) {
    return { suppressed: true, reason: 'ignored_pause', nextAttemptAtMs: now + ONE_DAY_MS };
  }
  // Even below the hard cap, apply exponential cooldown: if we've been ignored N times
  // recently, require 2^N * base cooldown since last send to this chat.
  // Cap at 7 days to prevent absurd durations (2^10 * 30min = 21 days uncapped).
  if (consecutiveIgnored > 0) {
    const uncapped = limits.cooldownAfterUserMs * 2 ** Math.min(consecutiveIgnored, 10);
    const exponentialCooldownMs = Math.min(uncapped, ONE_WEEK_MS);
    const lastSendMs = scheduler.lastSendMsForChat?.(chatId);
    if (lastSendMs && now - lastSendMs < exponentialCooldownMs) {
      return {
        suppressed: true,
        reason: 'ignored_exponential_backoff',
        nextAttemptAtMs: lastSendMs + exponentialCooldownMs,
      };
    }
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
    const nowMs = Date.now();

    if (!proactiveConfig.enabled) return;

    if (isInSleepWindow(new Date(), behaviorConfig.sleep)) return;

    const resolveTrustTier = async (chatId: ChatId): Promise<ChatTrustTier | undefined> => {
      const store = this.deps.memoryStore;
      if (!store) return undefined;
      const parsed = parseChatId(chatId);
      if (!parsed || parsed.kind === 'group') return undefined;
      const cid = `${parsed.channel}:${parsed.id}`;
      const person = await store.getPersonByChannelId(cid);
      if (!person) return 'new_contact';
      return deriveTrustTierForPerson(person);
    };

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
        const trustTier = await resolveTrustTier(event.chatId);
        const lastUserMessageMs = this.deps.getLastUserMessageMs?.(event.chatId);

        // Safety gate: don't do cold outreach for brand-new contacts.
        if (trustTier === 'new_contact' && event.kind !== 'reminder' && event.kind !== 'birthday') {
          scheduler.deferEvent(event.id, this.claimId, nowMs + 14 * ONE_DAY_MS);
          continue;
        }
        // Warming gate: at most 1 non-reminder outreach per day while getting to know them.
        if (
          trustTier === 'getting_to_know' &&
          event.kind !== 'reminder' &&
          event.kind !== 'birthday'
        ) {
          const dailySent = scheduler.countRecentSendsForChat(event.chatId, ONE_DAY_MS);
          if (dailySent >= 1) {
            scheduler.deferEvent(event.id, this.claimId, nowMs + ONE_DAY_MS);
            continue;
          }
        }

        const suppress = shouldSuppressOutreach(
          scheduler,
          proactiveConfig,
          event.kind,
          event.chatId,
          lastUserMessageMs,
          trustTier,
        );
        if (suppress.suppressed) {
          if (suppress.nextAttemptAtMs)
            scheduler.deferEvent(event.id, this.claimId, suppress.nextAttemptAtMs);
          else scheduler.releaseClaim(event.id, this.claimId);
          continue;
        }

        // Skip is best-effort anti-predictability. Never skip reminders/birthdays; never spin.
        if (
          event.kind !== 'reminder' &&
          event.kind !== 'birthday' &&
          proactiveConfig.skipRate > 0 &&
          skipRoll01(event.id, nowMs) < proactiveConfig.skipRate
        ) {
          scheduler.deferEvent(event.id, this.claimId, nowMs + skipDeferMs(event.id, nowMs));
          continue;
        }

        const sent = await this.deps.onProactive(event);
        if (!sent) {
          // If we decided not to send (e.g. HEARTBEAT_OK), don't retry forever.
          // Reminders/birthdays should be delivered; defer briefly in case the engine had a transient refusal.
          if (event.kind === 'reminder' || event.kind === 'birthday') {
            scheduler.deferEvent(event.id, this.claimId, nowMs + 15 * 60_000);
          } else {
            scheduler.markDelivered(event.id, this.claimId);
          }
          continue;
        }

        scheduler.markDelivered(event.id, this.claimId);
        scheduler.logProactiveSend(event.chatId, event.id);
      } catch (err) {
        scheduler.releaseClaim(event.id, this.claimId);
        this.logger.error('event.failed', { ...errorFields(err), chatId: String(event.chatId) });
      }
    }

    await this.deliverFollowUpCandidates(resolveTrustTier);
  }

  private async deliverFollowUpCandidates(
    resolveTrustTier: (chatId: ChatId) => Promise<ChatTrustTier | undefined>,
  ): Promise<void> {
    const { outboundLedger, scheduler, proactiveConfig } = this.deps;
    if (!outboundLedger) return;

    const nowMs = Date.now();
    const minSentAtMs = nowMs - 7 * ONE_DAY_MS;
    const maxSentAtMs = nowMs - 3 * ONE_DAY_MS;
    const candidates = outboundLedger.listUnansweredInWindow({
      minSentAtMs,
      maxSentAtMs,
      limit: 50,
    });
    if (candidates.length === 0) return;

    const seenChats = new Set<string>();
    for (const row of candidates) {
      if (seenChats.has(String(row.chatId))) continue;
      seenChats.add(String(row.chatId));

      const parsed = parseChatId(row.chatId);
      if (!parsed || parsed.kind === 'group') continue;

      const outstanding = outboundLedger.listRecent(row.chatId, 10).filter((r) => !r.gotReply);
      if (outstanding.length >= 2) continue;

      const event: ProactiveEvent = {
        id: -row.id,
        kind: 'follow_up_candidate',
        subject: `Follow up: ${row.contentPreview}`,
        chatId: row.chatId,
        triggerAtMs: nowMs,
        recurrence: null,
        delivered: false,
        createdAtMs: nowMs,
      };

      try {
        const lastUserMessageMs = this.deps.getLastUserMessageMs?.(event.chatId);
        const trustTier = await resolveTrustTier(event.chatId);
        const { suppressed } = shouldSuppressOutreach(
          scheduler,
          proactiveConfig,
          event.kind,
          event.chatId,
          lastUserMessageMs,
          trustTier,
        );
        if (suppressed) continue;

        if (proactiveConfig.skipRate > 0 && skipRoll01(event.id, nowMs) < proactiveConfig.skipRate)
          continue;

        const sent = await this.deps.onProactive(event);
        if (!sent) continue;
        scheduler.logProactiveSend(event.chatId, undefined);
      } catch (err) {
        this.logger.error('follow_up_candidate.failed', {
          ...errorFields(err),
          chatId: String(event.chatId),
        });
      }
    }
  }

  public healthCheck(): void {
    this.loop?.healthCheck();
  }
}
