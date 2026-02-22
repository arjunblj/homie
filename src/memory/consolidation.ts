import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LLMBackend } from '../backend/types.js';
import type { OpenhomieConfig } from '../config/types.js';
import { IntervalLoop } from '../util/intervalLoop.js';
import { errorFields, log } from '../util/logger.js';
import { renderCuratedLessonsMd } from './md-mirror/lessons.js';
import type { MemoryStore } from './store.js';

const truncateLines = (lines: string[], max: number): string[] => lines.slice(0, Math.max(0, max));

const normalizeEpisodeLine = (s: string): string =>
  s
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 400);

export async function runMemoryConsolidationOnce(opts: {
  readonly backend: LLMBackend;
  readonly store: MemoryStore;
  readonly config: OpenhomieConfig;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> {
  const { backend, store, config, signal } = opts;
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

  // Capsules: synthesize per-person "working profile" from their facts + lessons.
  // Refreshes stale capsules (>7 days old) in addition to creating new ones.
  const dirtyPersonLimit = Math.max(0, Math.floor(config.memory.consolidation.dirtyPersonLimit));
  if (dirtyPersonLimit <= 0) return;

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
  for (const person of toCapsule) {
    if (signal?.aborted) return;
    const facts = await store.getFactsForPerson(person.id, 200);
    const lessons = await store.getLessons('behavioral_feedback', 50);
    const relevantLessons = lessons.filter((l) => l.personId === person.id).slice(0, 10);

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
      'Format (dense, token-efficient):',
      '- 2-6 short sentences in plain text (no headings, no bullet lists)',
      '- Compress facts like: "Alex: SW eng @ Stripe. Hikes. Dog: Luna."',
    ].join('\n');

    const user = [
      `Person: ${person.displayName}`,
      person.capsule?.trim() ? `\nExisting capsule:\n${person.capsule.trim()}` : '',
      '',
      'Facts:',
      ...truncateLines(
        facts.map((f) => `- ${f.content}`),
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

  // Write curated lessons to markdown mirror.
  try {
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
