import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import { IntervalLoop } from '../util/intervalLoop.js';
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
  readonly config: HomieConfig;
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
      'Format:',
      '- 1 short paragraph summary',
      '- 3-8 bullets: norms, recurring topics, ongoing plans, boundaries',
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
  }

  const dirtyStyles = await store.claimDirtyPublicStyles(dirtyPublicStyleLimit);
  for (const personId of dirtyStyles) {
    if (signal?.aborted) return;
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
      'Format:',
      '- 1 short paragraph summary',
      '- 3-6 bullets: tone, boundaries, interaction patterns',
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
  }

  // Capsules: synthesize per-person "working profile" from their facts + lessons.
  const people = await store.listPeople(500, 0);
  for (const person of people) {
    if (signal?.aborted) return;
    const facts = await store.getFactsForPerson(person.id, 200);
    const lessons = await store.getLessons('behavioral_feedback', 50);
    const relevantLessons = lessons.filter((l) => l.personId === person.id).slice(0, 10);

    const sys = [
      'You are writing a compact, high-signal "person capsule" for an AI friend agent.',
      'It must be factual and actionable. No fluff.',
      'No private chain-of-thought; just the capsule content.',
      '',
      'Format:',
      '- 1 short paragraph summary',
      '- 3-8 bullets: preferences, constraints, ongoing projects, boundaries',
      '',
      'Keep it short. Avoid repeating the same information.',
    ].join('\n');

    const user = [
      `Person: ${person.displayName}`,
      `Relationship stage: ${person.relationshipStage}`,
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
}

export class MemoryConsolidationLoop {
  private loop: IntervalLoop | undefined;

  public constructor(
    private readonly deps: {
      readonly backend: LLMBackend;
      readonly store: MemoryStore;
      readonly config: HomieConfig;
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
