import { z } from 'zod';

import type { Episode, Fact } from '../memory/types.js';
import { defineTool } from './define.js';
import type { ToolDef } from './types.js';

const RecallInputSchema = z.object({
  query: z.string().min(1).max(500).describe('What you want to recall from memory.'),
  limit: z.number().int().min(1).max(20).optional().describe('Max items to return (default 8).'),
});

const oneLine = (input: string): string => input.replace(/\s+/gu, ' ').trim();

const clip = (input: string, maxChars: number): string => {
  const s = input.trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
};

const formatEpisode = (e: Episode): { createdAtMs: number; text: string } => ({
  createdAtMs: e.createdAtMs,
  text: clip(oneLine(e.content), 400),
});

const formatFact = (
  f: Fact,
): { id?: number; subject: string; content: string; category?: string } => ({
  ...(typeof f.id === 'number' ? { id: f.id } : {}),
  subject: f.subject,
  content: clip(oneLine(f.content), 260),
  ...(f.category ? { category: f.category } : {}),
});

export const recallTool: ToolDef = defineTool({
  name: 'recall',
  tier: 'safe',
  description: 'Recall relevant past context from durable memory (chat-scoped by default).',
  guidance: [
    'Use this to look up specifics from earlier in THIS chat.',
    'In group chats, do not request or reveal DM-only information.',
    'Prefer a short query and then ask a follow-up if needed.',
  ].join('\n'),
  inputSchema: RecallInputSchema,
  execute: async ({ query, limit }, ctx) => {
    const chat = ctx.chat;
    const store = ctx.services?.memoryStore;
    if (!chat) return { status: 'unavailable' as const, reason: 'missing_chat_context' as const };
    if (!store) return { status: 'unavailable' as const, reason: 'missing_memory_store' as const };

    const q = query.trim();
    const k = Math.max(1, Math.min(20, Math.floor(limit ?? 8)));

    try {
      const episodesAll = await store.hybridSearchEpisodes(q, Math.max(20, k * 5));
      const episodes = episodesAll
        .filter((e) => String(e.chatId) === String(chat.chatId))
        .slice(0, k);

      if (chat.isGroup) {
        const groupCapsule = await store.getGroupCapsule(chat.chatId);
        return {
          status: 'ok' as const,
          scope: { kind: 'group' as const, chatId: String(chat.chatId) },
          results: {
            ...(groupCapsule ? { groupCapsule: clip(groupCapsule, 900) } : {}),
            episodes: episodes.map(formatEpisode),
          },
          limits: { limit: k, episodesReturned: episodes.length },
        };
      }

      let personFacts: Array<ReturnType<typeof formatFact>> = [];
      if (chat.channelUserId) {
        const person = await store.getPersonByChannelId(chat.channelUserId);
        if (person) {
          const factsAll = await store.hybridSearchFacts(q, Math.max(20, k * 5));
          personFacts = factsAll
            .filter((f) => f.personId === person.id)
            .slice(0, k)
            .map(formatFact);
        }
      }

      return {
        status: 'ok' as const,
        scope: { kind: 'dm' as const, chatId: String(chat.chatId) },
        results: {
          ...(personFacts.length > 0 ? { personFacts } : {}),
          episodes: episodes.map(formatEpisode),
        },
        limits: {
          limit: k,
          episodesReturned: episodes.length,
          factsReturned: personFacts.length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
      return { status: 'error' as const, error: { message: clip(msg, 240) } };
    }
  },
});
