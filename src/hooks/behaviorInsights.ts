import { deriveBehaviorInsights } from '../behavior/insights.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { Lesson } from '../memory/types.js';
import type { SessionStore } from '../session/types.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { AgentHooks } from './types.js';

const DAY_MS = 86_400_000;

const isRecentDuplicate = (existing: Lesson, incomingRule: string, nowMs: number): boolean => {
  const rule = existing.rule?.trim();
  if (!rule || rule !== incomingRule) return false;
  const ageMs = Math.max(0, nowMs - (existing.createdAtMs ?? 0));
  return ageMs <= 7 * DAY_MS;
};

export function createBehaviorInsightsHook(opts: {
  readonly config: OpenhomieConfig;
  readonly memoryStore: MemoryStore | undefined;
  readonly sessionStore: SessionStore | undefined;
  readonly logger: Logger;
}): AgentHooks {
  const { config, memoryStore, sessionStore, logger } = opts;
  if (!memoryStore || !sessionStore) return {};
  if (!config.memory.enabled) return {};

  return {
    onSessionEnd: async ({ chatId }) => {
      const parsed = parseChatId(chatId);
      if (!parsed) return;
      const isGroup = parsed.kind === 'group';

      const nowMs = Date.now();
      const transcript = sessionStore.getMessages(chatId, 2_000);
      if (transcript.length === 0) return;

      const insights = deriveBehaviorInsights({
        config,
        isGroup,
        messages: transcript,
        nowMs,
      });
      if (insights.length === 0) return;

      let existing: Lesson[] = [];
      try {
        existing = await memoryStore.getLessons('behavior_insights', 200);
      } catch (err) {
        logger.debug('hook.behavior_insights.getLessons_failed', errorFields(err));
        existing = [];
      }

      // Bound IO per session end to avoid startup/shutdown spikes.
      const MAX_NEW_LESSONS = 3;
      let logged = 0;
      for (const ins of insights) {
        if (logged >= MAX_NEW_LESSONS) break;
        const rule = ins.rule.trim();
        if (!rule) continue;

        if (existing.some((l) => isRecentDuplicate(l, rule, nowMs))) continue;

        try {
          await memoryStore.logLesson({
            type: ins.type,
            category: 'behavior_insights',
            content: ins.content,
            rule,
            confidence: ins.confidence,
            createdAtMs: nowMs,
          });
          logged += 1;
        } catch (err) {
          // Never fail shutdown/turns due to memory IO.
          logger.debug('hook.behavior_insights.logLesson_failed', errorFields(err));
        }
      }
    },
  };
}
