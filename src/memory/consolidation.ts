import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieConfig } from '../config/types.js';
import { asMessageId } from '../types/ids.js';
import { IntervalLoop } from '../util/intervalLoop.js';
import { errorFields, log } from '../util/logger.js';
import type { MemoryExtractor } from './extractor.js';
import { renderCuratedLessonsMd } from './md-mirror/lessons.js';
import type { MemoryStore } from './store.js';

const truncateLines = (lines: string[], max: number): string[] => lines.slice(0, Math.max(0, max));

const normalizeEpisodeLine = (s: string): string =>
  s
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 400);

const isDuplicate = (a: string, b: string): boolean => {
  const na = a.toLowerCase().replace(/\s+/gu, ' ').trim();
  const nb = b.toLowerCase().replace(/\s+/gu, ' ').trim();
  if (na === nb) return true;
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && intersection / union > 0.85;
};

const contradictionKey = (raw: string): { key: 'works_at' | 'lives_in'; value: string } | null => {
  const t = raw.toLowerCase().replace(/\s+/gu, ' ').trim();
  const extract = (re: RegExp): string | null => {
    const m = t.match(re);
    const v = m?.[1]?.trim();
    if (!v) return null;
    return v
      .replace(/[.!,;:()[\]{}]/gu, '')
      .trim()
      .slice(0, 80);
  };
  const worksAt = extract(/\bworks?\s+at\s+(.+)$/u);
  if (worksAt) return { key: 'works_at', value: worksAt };
  const livesIn = extract(/\blives?\s+in\s+(.+)$/u);
  if (livesIn) return { key: 'lives_in', value: livesIn };
  return null;
};

const tokenizeForMention = (raw: string): string[] => {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/gu)
    .filter(Boolean)
    .slice(0, 200);
};

const tokensFromEpisodes = (episodes: ReadonlyArray<{ content: string }>): Set<string> => {
  const out = new Set<string>();
  for (const e of episodes) {
    for (const t of tokenizeForMention(e.content)) out.add(t);
    if (out.size > 20_000) break;
  }
  return out;
};

const isMentionedInEpisodes = (value: string, episodeTokens: ReadonlySet<string>): boolean => {
  for (const t of tokenizeForMention(value)) {
    if (episodeTokens.has(t)) return true;
  }
  return false;
};

const parseEpisodeConversation = (
  content: string,
): { userText: string; assistantText: string } | null => {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return null;
  const userPrefix = 'USER:';
  const idxUser = trimmed.indexOf(userPrefix);
  if (idxUser === -1) return null;
  const afterUser = trimmed.slice(idxUser + userPrefix.length);

  const idxFriend = afterUser.indexOf('\nFRIEND:');
  const idxReact = afterUser.indexOf('\nFRIEND_REACTION:');
  const splitIdx = idxFriend !== -1 ? idxFriend : idxReact !== -1 ? idxReact : -1;
  const userText = (splitIdx !== -1 ? afterUser.slice(0, splitIdx) : afterUser).trim();
  const assistantText =
    idxFriend !== -1 ? afterUser.slice(idxFriend + '\nFRIEND:'.length).trim() : '';
  return userText ? { userText, assistantText } : null;
};

export async function runMemoryConsolidationOnce(opts: {
  readonly backend: LLMBackend;
  readonly store: MemoryStore;
  readonly config: OpenhomieConfig;
  readonly extractor?: MemoryExtractor | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> {
  const { backend, store, config, extractor, signal } = opts;
  if (!config.memory.enabled || !config.memory.consolidation.enabled) return;

  // Bounded, incremental group-safe consolidation (group capsule + public style capsule).
  // Keep this deliberately small to avoid long pauses/spammy rewrites in active groups.
  const dirtyGroupLimit = config.memory.consolidation.dirtyGroupLimit;
  const dirtyPublicStyleLimit = config.memory.consolidation.dirtyPublicStyleLimit;

  const dirtyGroups = await store.claimDirtyGroupCapsules(dirtyGroupLimit);
  for (const chatId of dirtyGroups) {
    if (signal?.aborted) return;
    try {
      const existing = (await store.getGroupCapsule(chatId))?.trim() ?? '';
      const episodes = await store.getRecentEpisodes(chatId, 24 * 7);
      const lines = episodes.slice(0, 60).map((e) => `- ${normalizeEpisodeLine(e.content)}`);
      if (lines.length === 0) continue;

      const sys = [
        'You are writing a compact "group capsule" for an AI friend agent.',
        'This is for a group chat: capture norms, recurring topics, and shared context.',
        '',
        'Rules:',
        '- Only use what is present in the episodes (group chat history).',
        '- Do not invent private details.',
        '- Do not mention other chats, DMs, or where you learned things.',
        '- Keep it short and high-signal.',
        '',
        'Format (dense, token-efficient):',
        '- 2-5 short sentences in plain text (no headings, no bullet lists)',
        '- Use compact phrasing; avoid filler; keep names/topics concrete',
      ].join('\n');

      const user = [
        existing ? `Existing capsule:\n${existing}` : 'Existing capsule: (none)',
        '',
        'Recent episodes:',
        ...truncateLines(lines, 60),
      ].join('\n');

      const res = await backend.complete({
        role: config.memory.consolidation.modelRole,
        maxSteps: 2,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        signal,
      });

      const capsule = res.text.trim();
      if (!capsule) continue;
      await store.upsertGroupCapsule(chatId, capsule, Date.now());
    } finally {
      await store.completeDirtyGroupCapsule(chatId);
    }
  }

  const dirtyStyles = await store.claimDirtyPublicStyles(dirtyPublicStyleLimit);
  for (const personId of dirtyStyles) {
    if (signal?.aborted) return;
    try {
      const person = await store.getPerson(String(personId));
      const existing = (person?.publicStyleCapsule ?? '').trim();
      const episodes = await store.getRecentGroupEpisodesForPerson(personId, 24 * 14);
      const lines = episodes.slice(0, 80).map((e) => `- ${normalizeEpisodeLine(e.content)}`);
      if (lines.length === 0) continue;

      const sys = [
        'You are writing a compact "public style capsule" for an AI friend agent.',
        'This capsule must be cross-group safe and derived ONLY from group chat episodes.',
        '',
        'Rules:',
        '- Describe tone, humor, and interaction preferences visible in group chat.',
        '- Do not include sensitive personal facts.',
        '- Do not mention other chats, DMs, or where you learned things.',
        '- Keep it short and actionable.',
        '',
        'Format (dense, token-efficient):',
        '- 2-4 short sentences in plain text (no headings, no bullet lists)',
        '- Focus on voice/tone cues that matter for replying naturally in groups',
      ].join('\n');

      const user = [
        person ? `Person: ${person.displayName}` : `PersonId: ${String(personId)}`,
        existing ? `Existing public style:\n${existing}` : 'Existing public style: (none)',
        '',
        'Recent group episodes:',
        ...truncateLines(lines, 80),
      ].join('\n');

      const res = await backend.complete({
        role: config.memory.consolidation.modelRole,
        maxSteps: 2,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        signal,
      });

      const capsule = res.text.trim();
      if (!capsule) continue;
      await store.updatePublicStyleCapsule(personId, capsule);
    } finally {
      await store.completeDirtyPublicStyle(personId);
    }
  }

  // Catch-up extraction: retry episodes that never got extracted (e.g. tool crashes, LLM parse failures).
  if (extractor) {
    const maxEpisodes = Math.max(0, Math.floor(config.memory.consolidation.maxEpisodesPerRun));
    const needs = await store.listEpisodesNeedingExtraction(maxEpisodes);
    const extractedAtMs = Date.now();
    for (const e of needs) {
      if (signal?.aborted) return;
      if (!e.id) continue;

      const convo = parseEpisodeConversation(e.content);
      if (!convo) {
        try {
          await store.markEpisodeExtracted(e.id, extractedAtMs);
        } catch (err) {
          log.child({ component: 'consolidation' }).debug('catch_up.mark_failed', errorFields(err));
        }
        continue;
      }
      const parsed = parseChatId(e.chatId);
      if (!parsed) {
        try {
          await store.markEpisodeExtracted(e.id, extractedAtMs);
        } catch (err) {
          log.child({ component: 'consolidation' }).debug('catch_up.mark_failed', errorFields(err));
        }
        continue;
      }

      const isGroup = e.isGroup ?? parsed.kind === 'group';
      const msg: IncomingMessage = {
        channel: parsed.channel,
        chatId: e.chatId,
        messageId: asMessageId(`catch_up:${String(e.id)}`),
        authorId: parsed.kind === 'group' ? `group:${parsed.id}` : parsed.id,
        authorDisplayName: undefined,
        text: convo.userText,
        isGroup,
        ...(isGroup ? { mentioned: false } : {}),
        isOperator: false,
        timestampMs: e.createdAtMs,
      };

      await extractor.extractAndReconcile({
        msg,
        userText: convo.userText,
        assistantText: convo.assistantText,
        episodeId: e.id,
      });
    }
  }

  // Capsules: synthesize per-person "working profile" from their facts + lessons.
  // Refreshes stale capsules (>7 days old) in addition to creating new ones.
  const dirtyPersonLimit = Math.max(0, Math.floor(config.memory.consolidation.dirtyPersonLimit));
  const nowMs = Date.now();
  const people = await store.listPeople(500, 0);
  const STALE_CAPSULE_MS = 7 * 86_400_000;
  const toCapsule = people
    .filter((p) => {
      if (!p.capsule?.trim()) return true;
      // `updatedAtMs` is bumped for lots of reasons (any incoming message, score updates, etc).
      // Capsule freshness needs its own clock.
      const capsuleAt = p.capsuleUpdatedAtMs;
      if (typeof capsuleAt !== 'number') return true;
      if (nowMs - capsuleAt > STALE_CAPSULE_MS) return true;
      return false;
    })
    .slice(0, dirtyPersonLimit);
  if (dirtyPersonLimit > 0) {
    for (const person of toCapsule) {
      if (signal?.aborted) return;
      const rawFacts = await store.getFactsForPerson(person.id, 200);
      const lessons = await store.getLessons('behavioral_feedback', 50);
      const relevantLessons = lessons.filter((l) => l.personId === person.id).slice(0, 10);

      // Structured staleness pruning: only keep concerns/goals that were mentioned recently.
      try {
        const structured = await store.getStructuredPersonData(person.id);
        const window = await store.getRecentDmEpisodesForPerson(person.id, 24 * 14);
        const episodeTokens = tokensFromEpisodes(window);
        const freshConcerns = structured.currentConcerns.filter((c) =>
          isMentionedInEpisodes(c, episodeTokens),
        );
        const freshGoals = structured.goals.filter((g) => isMentionedInEpisodes(g, episodeTokens));
        if (
          freshConcerns.length !== structured.currentConcerns.length ||
          freshGoals.length !== structured.goals.length
        ) {
          await store.updateStructuredPersonData(person.id, {
            currentConcerns: freshConcerns,
            goals: freshGoals,
          });
        }
      } catch (err) {
        log
          .child({ component: 'consolidation' })
          .debug('structured_prune_failed', errorFields(err));
      }

      // Fact cleanup: dedupe and retire obvious contradictions by keeping the newest entry.
      const facts = rawFacts.slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      const kept: typeof facts = [];
      const retireIds: Array<Exclude<(typeof facts)[number]['id'], undefined>> = [];
      const seenByCategory = new Map<string, typeof facts>();
      const seenKeyed = new Map<string, { value: string; keptId: (typeof retireIds)[number] }>();
      for (const f of facts) {
        if (f.id === undefined) {
          kept.push(f);
          continue;
        }
        const cat = f.category ?? '_';
        const already = seenByCategory.get(cat) ?? [];
        if (already.some((k) => isDuplicate(k.content, f.content))) {
          retireIds.push(f.id);
          continue;
        }
        const ck = contradictionKey(f.content);
        if (ck) {
          const mapKey = `${cat}:${ck.key}`;
          const prior = seenKeyed.get(mapKey);
          if (prior && prior.value !== ck.value) {
            retireIds.push(f.id);
            continue;
          }
          seenKeyed.set(mapKey, { value: ck.value, keptId: f.id });
        }
        kept.push(f);
        seenByCategory.set(cat, [...already, f]);
      }
      for (const id of retireIds) {
        try {
          await store.setFactCurrent(id, false);
        } catch (err) {
          log.child({ component: 'consolidation' }).debug('fact_retire_failed', errorFields(err));
        }
      }

      const sys = [
        'You are writing a compact, high-signal "person capsule" for an AI friend agent.',
        'Be a RUTHLESS quality filter. Only include information that would genuinely help have better conversations.',
        '',
        'DISCARD immediately:',
        '- "participated in conversation" or "sent a greeting"',
        '- generic group membership facts',
        '- vague observations without specifics',
        '- duplicate or near-duplicate information',
        '',
        'KEEP only if:',
        '- Specific, durable fact (job, company, project, family, location)',
        '- Reveals a preference or communication style',
        '- Captures a relationship dynamic',
        '- Would help avoid a mistake or have a better interaction',
        '',
        'Format:',
        '- 1 short paragraph summary',
        '- 3-8 bullets: preferences, constraints, ongoing projects, boundaries',
      ].join('\n');

      const user = [
        `Person: ${person.displayName}`,
        person.capsule?.trim() ? `\nExisting capsule:\n${person.capsule.trim()}` : '',
        '',
        'Facts:',
        ...truncateLines(
          kept.map((f) => `- ${f.content}`),
          60,
        ),
        '',
        'Behavioral lessons (may be empty):',
        ...truncateLines(
          relevantLessons.map((l) => `- ${l.rule ?? l.content}`),
          15,
        ),
      ].join('\n');

      const res = await backend.complete({
        role: config.memory.consolidation.modelRole,
        maxSteps: 2,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        signal,
      });

      const capsule = res.text.trim();
      if (!capsule) continue;
      await store.updatePersonCapsule(person.id, capsule);
    }
  }

  // Write curated lessons to markdown mirror.
  try {
    // Promote validated lessons into "Heuristics".
    const lessons0 = await store.getLessons('behavioral_feedback', 250);
    for (const l of lessons0) {
      if (!l.id) continue;
      const validated = l.timesValidated ?? 0;
      const violated = l.timesViolated ?? 0;
      if (validated >= 2 && violated <= 1 && l.promoted !== true) {
        await store.setLessonPromoted(l.id, true);
      }
    }

    // Pattern detection (L2 gap analysis): repeated failure/success types in 24h.
    const DAY_MS = 86_400_000;
    const sinceMs = nowMs - DAY_MS;
    const recent = lessons0.filter((l) => (l.createdAtMs ?? 0) >= sinceMs);
    const byType = new Map<string, number>();
    for (const l of recent) {
      const type = l.type?.trim();
      if (!type) continue;
      if (l.content.trim().startsWith('Pattern:')) continue;
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    for (const [type, count] of byType.entries()) {
      if (count < 3) continue;
      const alreadyLogged = recent.some(
        (l) => l.content.includes('Pattern:') && l.content.includes(type),
      );
      if (alreadyLogged) continue;
      await store.logLesson({
        category: 'behavioral_feedback',
        type: 'observation',
        content: `Pattern: ${type} occurred ${count} times in 24h. Perform gap analysis and promote a heuristic if appropriate.`,
        createdAtMs: nowMs,
      });
    }

    const dataDir = config.paths.dataDir;
    const mdDir = path.join(dataDir, 'md');
    mkdirSync(mdDir, { recursive: true });
    const lessons = await store.getLessons('behavioral_feedback', 200);
    const md = renderCuratedLessonsMd(lessons);
    await writeFile(path.join(mdDir, 'lessons.md'), md, 'utf8');
  } catch (err) {
    log.child({ component: 'consolidation' }).debug('lessons_md_failed', errorFields(err));
  }
}

export class MemoryConsolidationLoop {
  private loop: IntervalLoop | undefined;

  public constructor(
    private readonly deps: {
      readonly backend: LLMBackend;
      readonly store: MemoryStore;
      readonly config: OpenhomieConfig;
      readonly extractor?: MemoryExtractor | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ) {}

  public start(): void {
    const { config } = this.deps;
    if (!config.memory.enabled || !config.memory.consolidation.enabled) return;
    if (this.loop) return;

    const everyMs = Math.max(60_000, config.memory.consolidation.intervalMs);
    this.loop = new IntervalLoop({
      name: 'memory_consolidation',
      everyMs,
      tick: async () => runMemoryConsolidationOnce(this.deps),
      signal: this.deps.signal,
    });
    this.loop.start();
  }

  public stop(): void {
    this.loop?.stop();
    this.loop = undefined;
  }

  public healthCheck(): void {
    this.loop?.healthCheck();
  }
}
