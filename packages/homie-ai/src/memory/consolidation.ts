import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import { IntervalLoop } from '../util/intervalLoop.js';
import type { MemoryStore } from './store.js';

const truncateLines = (lines: string[], max: number): string[] => lines.slice(0, Math.max(0, max));

export async function runMemoryConsolidationOnce(opts: {
  readonly backend: LLMBackend;
  readonly store: MemoryStore;
  readonly config: HomieConfig;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> {
  const { backend, store, config, signal } = opts;
  if (!config.memory.enabled || !config.memory.consolidation.enabled) return;

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
