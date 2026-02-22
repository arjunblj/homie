import type { ChatId, FactId } from '../types/ids.js';
import { errorFields, log } from '../util/logger.js';
import { estimateTokens, truncateToTokenBudget } from '../util/tokens.js';
import type { MemoryStore } from './store.js';
import {
  type ChatTrustTier,
  deriveTrustTierForPerson,
  type Fact,
  type FactCategory,
  type Lesson,
} from './types.js';

export interface MemoryContext {
  readonly text: string;
  readonly tokensUsed: number;
  /** True when we intentionally skipped retrieval (phatic/low-signal query). */
  readonly skipped?: boolean | undefined;
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

const MEMORY_USE_RULES_LINES = [
  '### Memory use rules',
  '- Memory fragments are raw material - synthesize, never quote or recite',
  '- Only surface a memory if it naturally fits THIS specific moment',
  '- If memory conflicts with the current message, prefer the latest instruction',
  '- When in doubt, ignore the memory entirely',
] as const;

const BEHAVIOR_INSIGHTS_GLOBAL_CATEGORY = 'behavior_insights';
const BEHAVIOR_INSIGHTS_GROUP_CATEGORY = 'behavior_insights_group';
const BEHAVIOR_INSIGHTS_TOKEN_BUDGET = 240;
const BEHAVIOR_INSIGHTS_CACHE_TTL_MS = 60_000;

type BehaviorInsightsCache = {
  readonly kind: 'ready';
  readonly atMs: number;
  readonly global: Lesson[];
  readonly group: Lesson[];
  readonly hasGroup: boolean;
};

type BehaviorInsightsCachePending = {
  readonly kind: 'pending';
  readonly atMs: number;
  readonly promise: Promise<Omit<BehaviorInsightsCache, 'kind' | 'atMs'>>;
};

const behaviorInsightsCacheByStore = new WeakMap<
  MemoryStore,
  BehaviorInsightsCache | BehaviorInsightsCachePending
>();

async function getBehaviorInsightsCached(opts: {
  store: MemoryStore;
  nowMs: number;
  includeGroup: boolean;
}): Promise<{ global: Lesson[]; group: Lesson[] }> {
  const { store, nowMs, includeGroup } = opts;

  const isFresh = (atMs: number): boolean =>
    nowMs - atMs >= 0 && nowMs - atMs < BEHAVIOR_INSIGHTS_CACHE_TTL_MS;

  const cache = behaviorInsightsCacheByStore.get(store);

  if (cache?.kind === 'ready' && isFresh(cache.atMs)) {
    if (!includeGroup || cache.hasGroup) {
      return { global: cache.global, group: cache.group };
    }
  }

  if (cache?.kind === 'pending' && isFresh(cache.atMs)) {
    try {
      const res = await cache.promise;
      if (!includeGroup || res.hasGroup) return { global: res.global, group: res.group };
    } catch (err) {
      log.debug('memory.behavior_insights_cache_await_failed', errorFields(err));
    }
  }

  const p = (async (): Promise<Omit<BehaviorInsightsCache, 'kind' | 'atMs'>> => {
    const settled = await Promise.allSettled([
      store.getLessons(BEHAVIOR_INSIGHTS_GLOBAL_CATEGORY, 50),
      includeGroup ? store.getLessons(BEHAVIOR_INSIGHTS_GROUP_CATEGORY, 50) : Promise.resolve([]),
    ]);
    const global =
      settled[0].status === 'fulfilled'
        ? settled[0].value.filter((l) => !l.personId)
        : ([] as Lesson[]);
    const group =
      settled[1].status === 'fulfilled'
        ? settled[1].value.filter((l) => !l.personId)
        : ([] as Lesson[]);

    if (settled[0].status === 'rejected') {
      log.debug('memory.behavior_insights_global_failed', errorFields(settled[0].reason));
    }
    if (settled[1].status === 'rejected') {
      log.debug('memory.behavior_insights_group_failed', errorFields(settled[1].reason));
    }

    return { global, group, hasGroup: includeGroup };
  })();

  behaviorInsightsCacheByStore.set(store, { kind: 'pending', atMs: nowMs, promise: p });
  const res = await p;
  behaviorInsightsCacheByStore.set(store, { kind: 'ready', atMs: nowMs, ...res });
  return { global: res.global, group: res.group };
}

function shouldSkipRetrieval(query: string): boolean {
  const t = query.trim();
  if (!t) return true;
  // Short messages can still be high-signal ("bday?", "u free?", "I'm 25").
  // Only skip ultra-short messages when they have no obvious signal.
  if (t.includes('?')) return false;
  if (/@|\d/u.test(t)) return false;
  if (t.length < 4) return true;
  if (/^(gm|gn|hi|hey|yo|sup|lol|lmao|haha|nice|k|ok|bet|fr|facts|true)\b/i.test(t)) return true;
  return false;
}

const TIER_ALLOWED_CATEGORIES: Record<ChatTrustTier, readonly FactCategory[]> = {
  new_contact: ['preference', 'misc'],
  getting_to_know: ['preference', 'misc', 'professional', 'plan'],
  close_friend: ['preference', 'misc', 'professional', 'plan', 'personal', 'relationship'],
} as const;

const CATEGORY_RELEVANCE_FLOOR: Record<FactCategory, number> = {
  preference: 0.3,
  misc: 0.3,
  professional: 0.4,
  plan: 0.4,
  personal: 0.6,
  relationship: 0.7,
} as const;

const DEFAULT_RELEVANCE_FLOOR = 0.3;

function coerceFactCategory(category: FactCategory | undefined): FactCategory {
  return category ?? 'misc';
}

function isCategoryAllowedForTier(category: FactCategory, tier: ChatTrustTier): boolean {
  return TIER_ALLOWED_CATEGORIES[tier].includes(category);
}

function formatAgeShort(nowMs: number, createdAtMs: number): string {
  const ageMs = Math.max(0, nowMs - createdAtMs);
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'i',
  'im',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'then',
  'there',
  'they',
  'this',
  'to',
  'u',
  'ur',
  'was',
  'we',
  'were',
  'what',
  'when',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

function tokenizeForRelevance(raw: string): string[] {
  const normalized = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!normalized) return [];
  const parts = normalized.split(/\s+/gu).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= 1) continue;
    if (STOPWORDS.has(p)) continue;
    out.push(p);
  }
  return out.slice(0, 24);
}

function overlapScore01(query: string, text: string): number {
  const q = tokenizeForRelevance(query);
  if (q.length === 0) return 0;

  // Minimal synonym expansion for common shorthand.
  const expanded = new Set<string>(q);
  if (expanded.has('bday')) expanded.add('birthday');
  if (expanded.has('bf')) expanded.add('boyfriend');
  if (expanded.has('gf')) expanded.add('girlfriend');

  const t = new Set(tokenizeForRelevance(text));
  if (t.size === 0) return 0;

  let intersection = 0;
  for (const tok of expanded) {
    if (t.has(tok)) intersection += 1;
  }

  const denom = Math.max(1, Math.min(expanded.size, t.size));
  return Math.max(0, Math.min(1, intersection / denom));
}

function combinedRelevance01(opts: { query: string; text: string; rankIdx: number }): number {
  const overlap = overlapScore01(opts.query, opts.text);
  const rankScore = 1 / Math.max(1, opts.rankIdx + 1);
  // If overlap is weak/zero, treat "top-ranked" as mildly relevant, but not enough
  // to justify sensitive memory injection.
  return Math.max(overlap, 0.5 * rankScore);
}

type SectionKey = 'facts' | 'episodes' | 'lessons';
type SectionBudgets = Record<SectionKey, number>;

function allocateBudget(
  sections: ReadonlyArray<{ key: SectionKey; topScore: number }>,
  totalBudget: number,
): SectionBudgets {
  const out: SectionBudgets = { facts: 0, episodes: 0, lessons: 0 };
  if (totalBudget <= 0 || sections.length === 0) return out;

  const scored = sections.map((s) => ({
    key: s.key,
    weight: Math.max(0, s.topScore - DEFAULT_RELEVANCE_FLOOR),
  }));
  const totalWeight = scored.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight < 0.01) return out;

  let allocated = 0;
  for (const s of scored) {
    const raw = (totalBudget * s.weight) / totalWeight;
    const b = Math.max(0, Math.floor(raw));
    out[s.key] = b;
    allocated += b;
  }

  let remaining = Math.max(0, totalBudget - allocated);
  const order = [...scored].sort((a, b) => b.weight - a.weight);
  while (remaining > 0 && order.length > 0) {
    for (const s of order) {
      if (remaining <= 0) break;
      out[s.key] += 1;
      remaining -= 1;
    }
  }

  return out;
}

function tokensFromEpisodeWindow(episodes: ReadonlyArray<{ content: string }>): Set<string> {
  const out = new Set<string>();
  for (const e of episodes) {
    for (const t of tokenizeForRelevance(e.content)) out.add(t);
    if (out.size > 20_000) break;
  }
  return out;
}

function isLikelyMentionedInEpisodes(opts: {
  value: string;
  episodeTokens: ReadonlySet<string>;
}): boolean {
  const toks = tokenizeForRelevance(opts.value);
  if (toks.length === 0) return false;
  for (const t of toks) {
    if (opts.episodeTokens.has(t)) return true;
  }
  return false;
}

export async function assembleMemoryContext(
  options: AssembleMemoryContextOptions,
): Promise<MemoryContext> {
  const { store, query, chatId, channelUserId, budget } = options;
  if (shouldSkipRetrieval(query)) return { text: '', tokensUsed: 0, skipped: true };

  const nowMs = Date.now();

  const scope: MemoryContextScope = options.scope ?? 'dm';
  const isGroup = scope === 'group';
  const capsuleEnabled = options.capsuleEnabled ?? true;
  const capsuleMaxTokens = options.capsuleMaxTokens ?? 200;

  const lines: string[] = [];
  let tokensUsed = 0;

  let started = false;
  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    for (const line of MEMORY_USE_RULES_LINES) {
      lines.push(line);
      tokensUsed += estimateTokens(line);
    }
    lines.push('');
    tokensUsed += estimateTokens('');
  };

  const pushLine = (line: string): void => {
    if (!line || tokensUsed >= budget) return;
    const lineTokens = estimateTokens(line);
    if (lineTokens > budget - tokensUsed) return;
    ensureStarted();
    lines.push(line);
    tokensUsed += lineTokens;
  };

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
      ensureStarted();
      lines.push(header);
      lines.push(...kept);
      tokensUsed += headerTokens + kept.reduce((sum, item) => sum + estimateTokens(item), 0);
    }
  };

  // 1. Relationship frame (DM only): never inject DM-private memory into group chats.
  const person = await store.getPersonByChannelId(channelUserId);
  if (!isGroup && person) {
    const frame = `Person: ${person.displayName} (${deriveTrustTierForPerson(person)})`;
    pushLine(frame);

    const capsule = capsuleEnabled ? person.capsule?.trim() : '';
    if (capsule) {
      const capsuleLine = `Capsule: ${truncateToTokenBudget(capsule, capsuleMaxTokens)}`;
      pushLine(capsuleLine);
    }
  }

  // 1a. Structured person data (DM only).
  if (!isGroup && person) {
    const stalenessEpisodes = await store.getRecentEpisodes(chatId, 24 * 14);
    const episodeTokens = tokensFromEpisodeWindow(stalenessEpisodes);

    const structured = await store.getStructuredPersonData(person.id);
    const parts: string[] = [];
    const freshConcerns = structured.currentConcerns.filter((c) =>
      isLikelyMentionedInEpisodes({ value: c, episodeTokens }),
    );
    const freshGoals = structured.goals.filter((g) =>
      isLikelyMentionedInEpisodes({ value: g, episodeTokens }),
    );

    if (freshConcerns.length > 0) {
      parts.push(`On their mind lately: ${freshConcerns.join(', ')}`);
    }
    if (freshGoals.length > 0) {
      parts.push(`Working toward: ${freshGoals.join(', ')}`);
    }
    if (structured.lastMoodSignal) {
      parts.push(`Mood: ${structured.lastMoodSignal}`);
    }
    if (structured.curiosityQuestions.length > 0) {
      parts.push(`Curious about: ${structured.curiosityQuestions.slice(0, 3).join(' / ')}`);
    }
    for (const part of parts) {
      if (tokensUsed >= budget) break;
      pushLine(part);
    }
  }

  // 1b. Group-safe memory: group capsule + public style capsule (derived only from group messages).
  if (isGroup) {
    const groupCapsule = (await store.getGroupCapsule(chatId))?.trim() ?? '';
    if (groupCapsule) {
      const line = `GroupCapsule: ${truncateToTokenBudget(groupCapsule, capsuleMaxTokens)}`;
      pushLine(line);
    }

    const publicStyle = capsuleEnabled ? person?.publicStyleCapsule?.trim() : '';
    if (publicStyle) {
      const line = `PublicStyle: ${truncateToTokenBudget(publicStyle, Math.floor(capsuleMaxTokens * 0.6))}`;
      pushLine(line);
    }
  }

  // 1c. Global behavior insights (group-safe + DM-safe): short, durable heuristics about our own behavior.
  try {
    const { global, group } = await getBehaviorInsightsCached({
      store,
      nowMs,
      includeGroup: isGroup,
    });
    const candidates = isGroup ? [...global, ...group] : global;
    const seenRules = new Set<string>();
    const items = candidates
      .map((l) => (l.rule ?? l.content).trim())
      .filter(Boolean)
      .filter((rule) => {
        if (seenRules.has(rule)) return false;
        seenRules.add(rule);
        return true;
      })
      .slice(0, 6)
      .map((t) => `- ${truncateToTokenBudget(t, 90)}`);
    if (items.length > 0) {
      addSection(
        'Behavior insights:',
        items,
        Math.min(BEHAVIOR_INSIGHTS_TOKEN_BUDGET, Math.max(0, budget - tokensUsed)),
      );
    }
  } catch (err) {
    // Best-effort: never fail turns due to lessons IO.
    log.debug('memory.behavior_insights_failed', errorFields(err));
  }

  // Sections below are relevance-budgeted (CAR-style): when relevance is weak, use less context.
  const remainingBudget = Math.max(0, budget - tokensUsed);

  // 2. Facts (DM only): gated by trust tier + sensitivity floors.
  const tier: ChatTrustTier = deriveTrustTierForPerson(person);
  const factCandidates: Fact[] =
    !isGroup && person
      ? (await store.hybridSearchFacts(`${person.displayName} ${query}`.trim(), 30)).filter(
          (f) => f.personId === person.id,
        )
      : !isGroup
        ? (await store.hybridSearchFacts(query, 20)).filter((f) => !f.personId)
        : [];

  const scoredFacts: Array<{ fact: Fact; score: number }> = factCandidates
    .map((fact, idx) => {
      const category = coerceFactCategory(fact.category);
      const score = combinedRelevance01({ query, text: fact.content, rankIdx: idx });
      return { fact: { ...fact, category }, score };
    })
    .filter((x) => {
      const category = coerceFactCategory(x.fact.category);
      if (person && !isCategoryAllowedForTier(category, tier)) return false;
      return x.score >= (CATEGORY_RELEVANCE_FLOOR[category] ?? DEFAULT_RELEVANCE_FLOOR);
    });

  // 3. Episodes: chat-scoped recent context (continuity across compaction).
  const episodes = (await store.getRecentEpisodes(chatId, 72)).slice(0, 12);
  const scoredEpisodes: Array<{ content: string; score: number }> = episodes
    .map((e, idx) => ({
      content: e.content,
      score: combinedRelevance01({ query, text: e.content, rankIdx: idx }),
    }))
    .filter((x) => x.score >= DEFAULT_RELEVANCE_FLOOR);

  // 4. Lessons (DM only): deterministic relevance by overlap/rank, scoped to person if present.
  const lessons: Lesson[] =
    !isGroup && person ? await store.getLessons('behavioral_feedback', 200) : [];
  const scopedLessons: Lesson[] = person
    ? lessons.filter((l) => !l.personId || l.personId === person.id)
    : [];
  const scoredLessons: Array<{ lesson: Lesson; score: number }> = scopedLessons
    .slice(0, 50)
    .map((lesson, idx) => ({
      lesson,
      score: combinedRelevance01({
        query,
        text: lesson.rule ?? lesson.content,
        rankIdx: idx,
      }),
    }))
    .filter((x) => x.score >= DEFAULT_RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const sectionBudgets = allocateBudget(
    [
      { key: 'facts', topScore: scoredFacts[0]?.score ?? 0 },
      { key: 'episodes', topScore: scoredEpisodes[0]?.score ?? 0 },
      { key: 'lessons', topScore: scoredLessons[0]?.score ?? 0 },
    ],
    remainingBudget,
  );

  // 2. Facts section
  if (!isGroup && scoredFacts.length > 0 && sectionBudgets.facts > 0 && tokensUsed < budget) {
    const header = 'Facts:';
    const headerTokens = estimateTokens(header);
    let remainingFactTokens = Math.max(0, sectionBudgets.facts - headerTokens);
    const keptLines: string[] = [];
    const keptIds: FactId[] = [];
    for (const { fact } of scoredFacts) {
      const age = formatAgeShort(nowMs, fact.createdAtMs);
      const line = `- [${age}] ${truncateToTokenBudget(fact.content, 60)}`;
      const t = estimateTokens(line);
      if (t > remainingFactTokens) break;
      keptLines.push(line);
      if (fact.id) keptIds.push(fact.id);
      remainingFactTokens -= t;
    }
    if (keptLines.length > 0) {
      ensureStarted();
      lines.push(header);
      lines.push(...keptLines);
      tokensUsed += headerTokens + keptLines.reduce((sum, l) => sum + estimateTokens(l), 0);
      if (keptIds.length > 0) {
        try {
          await store.touchFacts(keptIds, nowMs);
        } catch (err) {
          // Best-effort; never block a turn due to memory bookkeeping.
          log.debug('memory.touch_facts_failed', errorFields(err));
        }
      }
    }
  }

  // 3. Episodes section
  addSection(
    'Recent context:',
    scoredEpisodes.slice(0, 8).map((e) => `- ${truncateToTokenBudget(e.content, 80)}`),
    sectionBudgets.episodes,
  );

  // 4. Lessons section
  addSection(
    'Lessons:',
    scoredLessons
      .slice(0, 5)
      .map((l) => `- ${truncateToTokenBudget(l.lesson.rule ?? l.lesson.content, 60)}`),
    sectionBudgets.lessons,
  );

  if (lines.length === 0) return { text: '', tokensUsed: 0, skipped: false };

  const text = `=== MEMORY CONTEXT (DATA) ===\n${lines.join('\n')}`;
  return { text, tokensUsed: estimateTokens(text), skipped: false };
}
