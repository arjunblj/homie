import { deriveBehaviorInsights } from '../behavior/insights.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { Lesson } from '../memory/types.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { AgentHooks } from './types.js';

const DAY_MS = 86_400_000;
const BEHAVIOR_INSIGHTS_GLOBAL_CATEGORY = 'behavior_insights';
const BEHAVIOR_INSIGHTS_GROUP_CATEGORY = 'behavior_insights_group';
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const COMPACTION_MIN_INTERVAL_MS = 2 * 60 * 60_000;

const isRecentDuplicate = (existing: Lesson, incomingRule: string, nowMs: number): boolean => {
  const rule = existing.rule?.trim();
  if (!rule || rule !== incomingRule) return false;
  const ageMs = Math.max(0, nowMs - (existing.createdAtMs ?? 0));
  return ageMs <= DEDUPE_WINDOW_MS;
};

export function createBehaviorInsightsHook(opts: {
  readonly config: OpenhomieConfig;
  readonly memoryStore: MemoryStore | undefined;
  readonly sessionStore: SessionStore | undefined;
  readonly logger: Logger;
}): AgentHooks {
  const { config, memoryStore, sessionStore, logger } = opts;
  if (!memoryStore) return {};
  if (!config.memory.enabled) return {};

  const lastCompactionRunAtByChat = new Map<string, number>();

  const categoryForInsight = (key: string, isGroup: boolean): string => {
    if (isGroup && key === 'group_rapid_dialogue') return BEHAVIOR_INSIGHTS_GROUP_CATEGORY;
    return BEHAVIOR_INSIGHTS_GLOBAL_CATEGORY;
  };

  const logFromTranscript = async (args: {
    isGroup: boolean;
    transcript: readonly SessionMessage[];
    nowMs: number;
    maxNewLessons: number;
  }): Promise<void> => {
    const { isGroup, transcript, nowMs, maxNewLessons } = args;
    if (transcript.length === 0) return;

    const insights = deriveBehaviorInsights({
      config,
      isGroup,
      messages: transcript,
      nowMs,
    });
    if (insights.length === 0) return;

    const insightsByCategory = new Map<string, typeof insights>();
    for (const ins of insights) {
      const cat = categoryForInsight(ins.key, isGroup);
      const arr = insightsByCategory.get(cat);
      if (arr) arr.push(ins);
      else insightsByCategory.set(cat, [ins]);
    }

    const existingByCategory = new Map<string, Lesson[]>();
    for (const category of insightsByCategory.keys()) {
      try {
        const existing = await memoryStore.getLessons(category, 200);
        existingByCategory.set(category, existing);
      } catch (err) {
        logger.debug('hook.behavior_insights.getLessons_failed', {
          category,
          ...errorFields(err),
        });
        existingByCategory.set(category, []);
      }
    }

    let logged = 0;
    for (const ins of insights) {
      if (logged >= maxNewLessons) break;
      const rule = ins.rule.trim();
      if (!rule) continue;

      const category = categoryForInsight(ins.key, isGroup);
      const existing = existingByCategory.get(category) ?? [];
      if (existing.some((l) => isRecentDuplicate(l, rule, nowMs))) continue;

      try {
        await memoryStore.logLesson({
          type: ins.type,
          category,
          content: ins.content,
          rule,
          confidence: ins.confidence,
          createdAtMs: nowMs,
        });
        logged += 1;
      } catch (err) {
        // Never fail turns/shutdown due to memory IO.
        logger.debug('hook.behavior_insights.logLesson_failed', { category, ...errorFields(err) });
      }
    }
  };

  return {
    onSessionCompacted: async ({ chatId, transcript }) => {
      const parsed = parseChatId(chatId);
      if (!parsed) return;
      if (parsed.channel === 'cli') return;

      const nowMs = Date.now();
      const last = lastCompactionRunAtByChat.get(String(chatId)) ?? 0;
      if (nowMs - last < COMPACTION_MIN_INTERVAL_MS) return;
      lastCompactionRunAtByChat.set(String(chatId), nowMs);

      try {
        await logFromTranscript({
          isGroup: parsed.kind === 'group',
          transcript,
          nowMs,
          maxNewLessons: 2,
        });
      } catch (err) {
        logger.debug('hook.behavior_insights.onSessionCompacted_failed', errorFields(err));
      }
    },
    onSessionEnd: async ({ chatId }) => {
      const parsed = parseChatId(chatId);
      if (!parsed) return;
      if (parsed.channel === 'cli') return;
      const isGroup = parsed.kind === 'group';

      const nowMs = Date.now();
      const transcript = sessionStore?.getMessages(chatId, 2_000) ?? [];
      await logFromTranscript({
        isGroup,
        transcript,
        nowMs,
        maxNewLessons: 3,
      });
    },
  };
}
