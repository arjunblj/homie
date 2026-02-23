import { z } from 'zod';

import type { LLMBackend } from '../../backend/types.js';
import { extractJsonObject } from '../../interview/json.js';
import type { Lesson } from '../../memory/types.js';
import type { SelfImproveItemDraft, SelfImprovePlanResult, SelfImproveScope } from './types.js';

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const previewLesson = (lesson: Lesson): string => {
  const raw = lesson.content ?? '';
  const clipped = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  return clipped.replace(/\s+/gu, ' ').trim();
};

const scopeSchema: z.ZodType<SelfImproveScope> = z.enum([
  'engine',
  'tools',
  'memory',
  'security',
  'proactive',
  'channels',
  'backend',
  'cli',
  'identity',
  'repo',
  'unknown',
]);

const PlannedItemSchema = z.object({
  classification: z.enum(['thorn', 'bud']),
  scope: scopeSchema,
  confidence: z.number().min(0).max(1),
  title: z.string().min(4).max(120),
  why: z.string().min(1).max(1200),
  proposal: z.string().min(1).max(2400),
  filesHint: z.array(z.string().min(1).max(180)).max(20).optional(),
  searchTerms: z.array(z.string().min(1).max(80)).max(20).optional(),
  lessonIds: z.array(z.number().int().positive()).min(1).max(40),
});

const PlannerOutputSchema = z.object({
  items: z.array(PlannedItemSchema).max(10),
});

export interface PlanSelfImproveParams {
  backend: LLMBackend;
  lessons: readonly Lesson[];
  maxItems: number;
  signal?: AbortSignal | undefined;
}

export async function planSelfImprove(
  params: PlanSelfImproveParams,
): Promise<SelfImprovePlanResult> {
  const maxItems = Math.max(1, Math.min(10, Math.floor(params.maxItems)));
  const sourceLessons = params.lessons
    .filter((l) => typeof l.id === 'number' && Number.isFinite(l.id))
    .slice(0, 50)
    .map((l) => ({
      lessonId: l.id as number,
      lessonType: l.type,
      confidence: l.confidence,
      createdAtMs: l.createdAtMs,
      preview: previewLesson(l),
    }));

  if (sourceLessons.length === 0) {
    return { planned: [], skippedBecauseNoLessons: true };
  }

  const prompt = [
    'You are an engineer improving the openhomie repo based on behavioral feedback lessons.',
    '',
    'Goal: propose a small set of concrete, code-level improvements that will most improve reliability/quality.',
    '',
    'Hard constraints:',
    '- Do NOT propose documentation-only work or planning docs.',
    '- Prefer changes in src/ (runtime, tools, memory, safety) over sweeping refactors.',
    '- Each item must be independently shippable.',
    '- Keep scope tight; avoid multi-week migrations.',
    '',
    `Return at most ${maxItems} items.`,
    '',
    'Lessons (newest first):',
    ...sourceLessons.map(
      (l) =>
        `- lessonId=${l.lessonId} type=${l.lessonType ?? 'unknown'} conf=${String(l.confidence ?? '')}\n  ${l.preview}`,
    ),
  ].join('\n');

  type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

  if (params.backend.completeObject) {
    const { output } = await params.backend.completeObject<PlannerOutput>({
      role: 'default',
      schema: PlannerOutputSchema,
      signal: params.signal,
      messages: [
        { role: 'system', content: 'You output only JSON that matches the schema.' },
        { role: 'user', content: prompt },
      ],
    });
    return {
      planned: coercePlannedItems(output.items, sourceLessons).slice(0, maxItems),
      skippedBecauseNoLessons: false,
    };
  }

  const res = await params.backend.complete({
    role: 'default',
    maxSteps: 1,
    signal: params.signal,
    messages: [
      { role: 'system', content: 'You output only JSON.' },
      { role: 'user', content: prompt },
    ],
  });

  const raw = extractJsonObject(res.text);
  const parsed = PlannerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`self-improve planner: invalid JSON output: ${parsed.error.message}`);
  }
  return {
    planned: coercePlannedItems(parsed.data.items, sourceLessons).slice(0, maxItems),
    skippedBecauseNoLessons: false,
  };
}

function coercePlannedItems(
  items: readonly z.infer<typeof PlannedItemSchema>[],
  sourceLessons: readonly {
    lessonId: number;
    lessonType?: string | undefined;
    confidence?: number | undefined;
    createdAtMs?: number | undefined;
    preview: string;
  }[],
): SelfImproveItemDraft[] {
  const byId = new Map<number, (typeof sourceLessons)[number]>();
  for (const l of sourceLessons) byId.set(l.lessonId, l);

  return items.map((it) => {
    const lessons = it.lessonIds.flatMap((id) => {
      const l = byId.get(id);
      return l ? [l] : [];
    });
    const attached = lessons.length > 0 ? lessons : sourceLessons.slice(0, 10);
    return {
      classification: it.classification,
      scope: it.scope,
      confidence: clamp01(it.confidence),
      title: it.title.trim(),
      why: it.why.trim(),
      proposal: it.proposal.trim(),
      ...(it.filesHint?.length
        ? { filesHint: it.filesHint.map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(it.searchTerms?.length
        ? { searchTerms: it.searchTerms.map((s) => s.trim()).filter(Boolean) }
        : {}),
      sourceLessons: attached,
    };
  });
}
