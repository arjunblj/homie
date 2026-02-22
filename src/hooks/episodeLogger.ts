import { parseChatId } from '../channels/chatId.js';
import type { MemoryStore } from '../memory/store.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { AgentHooks } from './types.js';

const cap = (input: string, max: number): string => {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 3))}...`;
};

const normalizeLine = (s: string): string =>
  s
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1000);

export function createEpisodeLoggerHook(opts: {
  readonly memoryStore: MemoryStore | undefined;
  readonly logger: Logger;
}): AgentHooks {
  const { memoryStore, logger } = opts;
  if (!memoryStore) return {};

  return {
    onSessionCompacted: async ({ chatId, summary }) => {
      const parsed = parseChatId(chatId);
      if (!parsed) return;

      const isGroup = parsed.kind === 'group';
      const normalized = normalizeLine(summary);
      const content = normalized ? cap(`SESSION_SUMMARY\n${normalized}`, 4000) : '';
      if (!content) return;

      try {
        await memoryStore.logEpisode({
          chatId,
          isGroup,
          content,
          createdAtMs: Date.now(),
        });
      } catch (err) {
        logger.debug('hook.episode_logger.failed', { chatId: String(chatId), ...errorFields(err) });
      }
    },
  };
}
