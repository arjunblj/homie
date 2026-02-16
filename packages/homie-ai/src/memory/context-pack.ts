import type { ChatId } from '../types/ids.js';
import { estimateTokens, truncateToTokenBudget } from '../util/tokens.js';
import type { Embedder } from './embeddings.js';
import type { MemoryStore } from './store.js';

export interface MemoryContext {
  readonly text: string;
  readonly tokensUsed: number;
}

export interface AssembleMemoryContextOptions {
  readonly store: MemoryStore;
  readonly query: string;
  readonly chatId: ChatId;
  readonly channelUserId: string;
  readonly budget: number;
  readonly embedder?: Embedder | undefined;
}

export async function assembleMemoryContext(
  options: AssembleMemoryContextOptions,
): Promise<MemoryContext> {
  const { store, query, chatId, channelUserId, budget } = options;

  // Migration fast-path: if the store provides a server-built context pack, use it
  if (store.getContextPack) {
    const pack = await store.getContextPack({
      query,
      chatId,
      channelType: channelUserId.split(':')[0],
      participants: [channelUserId],
      maxChars: budget * 4,
    });
    const text = pack.context.trim();
    if (text) {
      const wrapped = `=== MEMORY CONTEXT (DATA) ===\n${text}`;
      return { text: wrapped, tokensUsed: estimateTokens(wrapped) };
    }
    return { text: '', tokensUsed: 0 };
  }

  // Local assembly: budget-aware, relationship-prioritized
  const lines: string[] = [];
  let tokensUsed = 0;

  const addSection = (header: string, items: string[], sectionBudget: number): void => {
    if (items.length === 0 || tokensUsed >= budget) return;
    const headerTokens = estimateTokens(header);
    let remaining = Math.max(0, sectionBudget - headerTokens);
    const kept: string[] = [];
    for (const item of items) {
      const itemTokens = estimateTokens(item);
      if (itemTokens > remaining) break;
      kept.push(item);
      remaining -= itemTokens;
    }
    if (kept.length > 0) {
      lines.push(header);
      lines.push(...kept);
      tokensUsed += headerTokens + kept.reduce((sum, item) => sum + estimateTokens(item), 0);
    }
  };

  // 1. Relationship frame (always included, cheap)
  const person = await store.getPersonByChannelId(channelUserId);
  if (person) {
    const frame = `Person: ${person.displayName} (${person.relationshipStage})`;
    lines.push(frame);
    tokensUsed += estimateTokens(frame);
  }

  const remaining = budget - tokensUsed;
  const factBudget = Math.floor(remaining * 0.3);
  const episodeBudget = Math.floor(remaining * 0.3);
  const lessonBudget = Math.floor(remaining * 0.15);

  // 2. Relevant facts (30% of remaining budget)
  const facts = person
    ? await store.getFacts(person.displayName)
    : await store.searchFacts(query, 15);
  addSection(
    'Facts:',
    facts.map((f) => `- ${truncateToTokenBudget(f.content, 60)}`),
    factBudget,
  );

  // 3. Recent episodes (30% of remaining budget)
  const recentEpisodes = await store.getRecentEpisodes(chatId, 72);
  const searchedEpisodes = query.length > 5 ? await store.searchEpisodes(query, 5) : [];
  const seenEpisodeIds = new Set(recentEpisodes.map((e) => e.id));
  const crossChat = searchedEpisodes.filter((e) => !seenEpisodeIds.has(e.id));
  const allEpisodes = [...recentEpisodes.slice(0, 5), ...crossChat.slice(0, 3)];
  addSection(
    'Recent context:',
    allEpisodes.map((e) => `- ${truncateToTokenBudget(e.content, 80)}`),
    episodeBudget,
  );

  // 4. Lessons (15% of remaining budget)
  const lessons = await store.getLessons();
  addSection(
    'Lessons:',
    lessons.slice(0, 5).map((l) => `- [${l.category}] ${truncateToTokenBudget(l.content, 60)}`),
    lessonBudget,
  );

  if (lines.length === 0) return { text: '', tokensUsed: 0 };

  const text = `=== MEMORY CONTEXT (DATA) ===\n${lines.join('\n')}`;
  return { text, tokensUsed: estimateTokens(text) };
}
