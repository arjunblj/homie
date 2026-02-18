import type { ChatId, FactId } from '../types/ids.js';
import { errorFields, log } from '../util/logger.js';
import { estimateTokens, truncateToTokenBudget } from '../util/tokens.js';
import type { MemoryStore } from './store.js';
import type { Fact, Lesson } from './types.js';

export interface MemoryContext {
  readonly text: string;
  readonly tokensUsed: number;
}

export type MemoryContextScope = 'dm' | 'group';

export interface AssembleMemoryContextOptions {
  readonly store: MemoryStore;
  readonly query: string;
  readonly chatId: ChatId;
  readonly channelUserId: string;
  readonly budget: number;
  readonly scope?: MemoryContextScope | undefined;
  readonly capsuleEnabled?: boolean | undefined;
  readonly capsuleMaxTokens?: number | undefined;
}

export async function assembleMemoryContext(
  options: AssembleMemoryContextOptions,
): Promise<MemoryContext> {
  const { store, query, chatId, channelUserId, budget } = options;
  const scope: MemoryContextScope = options.scope ?? 'dm';
  const isGroup = scope === 'group';
  const capsuleEnabled = options.capsuleEnabled ?? true;
  const capsuleMaxTokens = options.capsuleMaxTokens ?? 200;

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

  // 1. Relationship frame (DM only): never inject personal memory into group chats.
  const person = isGroup ? null : await store.getPersonByChannelId(channelUserId);
  if (person) {
    const frame = `Person: ${person.displayName} (${person.relationshipStage})`;
    lines.push(frame);
    tokensUsed += estimateTokens(frame);

    const capsule = capsuleEnabled ? person.capsule?.trim() : '';
    if (capsule) {
      const capsuleLine = `Capsule: ${truncateToTokenBudget(capsule, capsuleMaxTokens)}`;
      lines.push(capsuleLine);
      tokensUsed += estimateTokens(capsuleLine);
    }
  }

  const remaining = budget - tokensUsed;
  const factBudget = Math.floor(remaining * 0.3);
  const episodeBudget = Math.floor(remaining * 0.3);
  const lessonBudget = Math.floor(remaining * 0.15);

  // 2. Relevant facts (30% of remaining budget)
  let facts: Fact[] = [];
  if (person) {
    const factQuery = `${person.displayName} ${query}`.trim();
    const candidate = await store.hybridSearchFacts(factQuery, 30);
    facts = candidate.filter((f) => f.personId === person.id);
    if (facts.length === 0) {
      facts = await store.getFactsForPerson(person.id, 200);
    }
  }
  if (facts.length > 0 && tokensUsed < budget && !isGroup) {
    const header = 'Facts:';
    const headerTokens = estimateTokens(header);
    let remainingFactTokens = Math.max(0, factBudget - headerTokens);
    const keptLines: string[] = [];
    const keptIds: FactId[] = [];
    for (const f of facts) {
      const line = `- ${truncateToTokenBudget(f.content, 60)}`;
      const t = estimateTokens(line);
      if (t > remainingFactTokens) break;
      keptLines.push(line);
      if (f.id) keptIds.push(f.id);
      remainingFactTokens -= t;
    }
    if (keptLines.length > 0) {
      lines.push(header);
      lines.push(...keptLines);
      tokensUsed += headerTokens + keptLines.reduce((sum, l) => sum + estimateTokens(l), 0);
      if (keptIds.length > 0) {
        try {
          await store.touchFacts(keptIds, Date.now());
        } catch (err) {
          // Best-effort; never block a turn due to memory bookkeeping.
          log.debug('memory.touch_facts_failed', errorFields(err));
        }
      }
    }
  }

  // 3. Recent episodes (30% of remaining budget)
  const recentEpisodes = await store.getRecentEpisodes(chatId, 72);
  const allEpisodes = recentEpisodes.slice(0, 8);
  addSection(
    'Recent context:',
    allEpisodes.map((e) => `- ${truncateToTokenBudget(e.content, 80)}`),
    episodeBudget,
  );

  // 4. Lessons (15% of remaining budget)
  const lessons: Lesson[] =
    !isGroup && person ? await store.getLessons('behavioral_feedback', 200) : [];
  const scopedLessons: Lesson[] = person
    ? lessons.filter((l) => !l.personId || l.personId === person.id)
    : [];
  addSection(
    'Lessons:',
    scopedLessons.slice(0, 5).map((l) => `- ${truncateToTokenBudget(l.rule ?? l.content, 60)}`),
    lessonBudget,
  );

  if (lines.length === 0) return { text: '', tokensUsed: 0 };

  const text = `=== MEMORY CONTEXT (DATA) ===\n${lines.join('\n')}`;
  return { text, tokensUsed: estimateTokens(text) };
}
