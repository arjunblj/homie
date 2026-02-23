import { z } from 'zod';
import type { LLMBackend, LLMMessage, LLMUsage } from '../backend/types.js';
import { checkSlop, enforceMaxLength } from './slop.js';

export type OutgoingKind = 'reactive' | 'proactive';

export type QualityGateVerdict = {
  pass: boolean;
  authenticity: number;
  naturalness: number;
  pressure: number;
  voiceMatch: number;
  notes: string;
};

const QualityGateVerdictSchema: z.ZodType<QualityGateVerdict> = z.object({
  pass: z
    .boolean()
    .describe(
      'true only if you would actually send this exact message as a real friend, right now.',
    ),
  authenticity: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('1=robotic/assistant, 5=unmistakably human friend'),
  naturalness: z.number().int().min(1).max(5).describe('1=stilted, 5=casual + fluent'),
  pressure: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('1=no pressure, 5=pushy / needy / forcing a reply'),
  voiceMatch: z.number().int().min(1).max(5).describe('1=generic, 5=on-character'),
  notes: z.string().max(240).describe('One short sentence. Mention the biggest issue if failing.'),
});

export interface GateOutgoingTextParams {
  readonly backend: LLMBackend;
  readonly kind: OutgoingKind;
  readonly draft: string;
  readonly maxChars: number;
  readonly isGroup: boolean;
  readonly identityAntiPatterns: readonly string[];
  readonly maxSentences?: number | undefined;
  readonly userTextHint?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly takeModelToken?: (() => Promise<void>) | undefined;
  readonly recordUsage?: ((res: { usage?: LLMUsage; modelId?: string }) => void) | undefined;
}

export interface GateOutgoingTextResult {
  readonly text?: string | undefined;
  readonly verdict?: QualityGateVerdict | undefined;
  readonly reason?: string | undefined;
  readonly attemptedRewrite: boolean;
}

const countSentences = (s: string): number => s.split(/[.!?]+/u).filter(Boolean).length;

const disciplineText = (text: string, opts: { maxChars: number; isGroup: boolean }): string => {
  const clipped = enforceMaxLength(text.trim(), opts.maxChars);
  return opts.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
};

const deterministicGate = (opts: {
  text: string;
  isGroup: boolean;
  maxChars: number;
  maxSentences?: number | undefined;
  identityAntiPatterns: readonly string[];
}): { pass: boolean; reason?: string } => {
  const t = disciplineText(opts.text, { maxChars: opts.maxChars, isGroup: opts.isGroup });
  if (!t) return { pass: false, reason: 'empty' };
  if (opts.maxSentences && countSentences(t) > opts.maxSentences) {
    return { pass: false, reason: 'sentence_cap' };
  }
  const slop = checkSlop(t, opts.identityAntiPatterns);
  if (slop.isSlop) return { pass: false, reason: 'slop' };
  return { pass: true };
};

const QUALITY_GATE_SYSTEM = [
  'You are a strict quality gate for an AI friend texting in a chat app.',
  'Decide if the draft is worth sending. When in doubt, fail it.',
  '',
  'Hard fails:',
  '- generic check-ins ("just checking in", "hope you are well")',
  '- assistant-y tone ("happy to help", "let me know if...")',
  '- reverse attribution ("i remember you said X" with no point)',
  '- pressure to reply, therapy voice, corporate voice',
  '- overly structured writing (bullets, headings, multiple paragraphs)',
  '',
  'Scoring guidance:',
  '- authenticity>=4, naturalness>=4, voiceMatch>=4, pressure<=2 usually implies pass',
  '- but pass=false if it feels forced or unnecessary',
].join('\n');

const buildQualityGateUserPrompt = (opts: {
  kind: OutgoingKind;
  draft: string;
  isGroup: boolean;
  maxChars: number;
  maxSentences?: number | undefined;
  userTextHint?: string | undefined;
}): string => {
  const parts = [
    `kind: ${opts.kind}`,
    `scope: ${opts.isGroup ? 'group' : 'dm'}`,
    `maxChars: ${opts.maxChars}`,
    ...(opts.maxSentences ? [`maxSentences: ${opts.maxSentences}`] : []),
    ...(opts.userTextHint ? [`userTextHint: ${opts.userTextHint.slice(0, 300)}`] : []),
    '',
    'draft:',
    opts.draft,
  ];
  return parts.join('\n');
};

const rewritePrompt = (opts: {
  kind: OutgoingKind;
  isGroup: boolean;
  maxChars: number;
  maxSentences?: number | undefined;
  userTextHint?: string | undefined;
  draft: string;
  notes: string;
}): { system: string; user: string } => {
  const system = [
    'Rewrite the message to sound like a real friend.',
    'No assistant tone. No generic check-ins. No pressure.',
    opts.isGroup ? 'Group chat: keep it one line.' : 'DM: keep it casual.',
    `Hard limit: <= ${opts.maxChars} chars.`,
    ...(opts.maxSentences ? [`Hard limit: <= ${opts.maxSentences} sentences.`] : []),
    'Return only the rewritten message text.',
  ].join('\n');
  const user = [
    `Why it failed: ${opts.notes}`,
    ...(opts.userTextHint ? [`Context: ${opts.userTextHint.slice(0, 300)}`] : []),
    '',
    'Original:',
    opts.draft,
  ].join('\n');
  return { system, user };
};

async function evaluateQualityBestEffort(opts: {
  backend: LLMBackend;
  kind: OutgoingKind;
  draft: string;
  isGroup: boolean;
  maxChars: number;
  maxSentences?: number | undefined;
  userTextHint?: string | undefined;
  identityAntiPatterns: readonly string[];
  signal?: AbortSignal | undefined;
  takeModelToken?: (() => Promise<void>) | undefined;
  recordUsage?: ((res: { usage?: LLMUsage; modelId?: string }) => void) | undefined;
}): Promise<{ verdict?: QualityGateVerdict | undefined; pass: boolean; reason?: string }> {
  // If the backend can't do structured output, fall back to deterministic gate.
  if (!opts.backend.completeObject) {
    const d = deterministicGate({
      text: opts.draft,
      isGroup: opts.isGroup,
      maxChars: opts.maxChars,
      maxSentences: opts.maxSentences,
      identityAntiPatterns: opts.identityAntiPatterns,
    });
    return { pass: d.pass, ...(d.reason ? { reason: d.reason } : {}) };
  }

  await opts.takeModelToken?.();

  // Note: keep messages tiny; we can't assume provider-side caching is active.
  const messages: LLMMessage[] = [
    { role: 'system', content: QUALITY_GATE_SYSTEM },
    {
      role: 'user',
      content: buildQualityGateUserPrompt({
        kind: opts.kind,
        draft: opts.draft,
        isGroup: opts.isGroup,
        maxChars: opts.maxChars,
        maxSentences: opts.maxSentences,
        userTextHint: opts.userTextHint,
      }),
    },
  ];

  try {
    const res = await opts.backend.completeObject<QualityGateVerdict>({
      role: 'fast',
      schema: QualityGateVerdictSchema,
      messages,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.recordUsage?.({
      ...(res.usage ? { usage: res.usage } : {}),
      ...(res.modelId ? { modelId: res.modelId } : {}),
    });
    const verdict = res.output;
    return { verdict, pass: Boolean(verdict.pass) };
  } catch (_err) {
    // Fail-safe but not catastrophic: if evaluation fails, do not hard-block delivery.
    // Deterministic gates (slop / caps) still apply via `deterministicGate`.
    const d = deterministicGate({
      text: opts.draft,
      isGroup: opts.isGroup,
      maxChars: opts.maxChars,
      maxSentences: opts.maxSentences,
      identityAntiPatterns: opts.identityAntiPatterns,
    });
    return { pass: d.pass, reason: 'eval_failed' };
  }
}

export async function gateOutgoingText(
  params: GateOutgoingTextParams,
): Promise<GateOutgoingTextResult> {
  const disciplined = disciplineText(params.draft, {
    maxChars: params.maxChars,
    isGroup: params.isGroup,
  });
  const det = deterministicGate({
    text: disciplined,
    isGroup: params.isGroup,
    maxChars: params.maxChars,
    maxSentences: params.maxSentences,
    identityAntiPatterns: params.identityAntiPatterns,
  });
  if (!det.pass) {
    // For bounded formatting/slop issues, try a single rewrite before silencing.
    const canRewrite = det.reason === 'slop' || det.reason === 'sentence_cap';
    if (!canRewrite) {
      return { reason: det.reason ?? 'deterministic_fail', attemptedRewrite: false };
    }

    const { system, user } = rewritePrompt({
      kind: params.kind,
      isGroup: params.isGroup,
      maxChars: params.maxChars,
      maxSentences: params.maxSentences,
      userTextHint: params.userTextHint,
      draft: disciplined,
      notes: det.reason ?? 'failed deterministic gate',
    });

    await params.takeModelToken?.();
    const rewrite = await params.backend.complete({
      role: 'fast',
      maxSteps: 1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.recordUsage?.({
      ...(rewrite.usage ? { usage: rewrite.usage } : {}),
      ...(rewrite.modelId ? { modelId: rewrite.modelId } : {}),
    });
    const rewritten = disciplineText(rewrite.text, {
      maxChars: params.maxChars,
      isGroup: params.isGroup,
    });

    const det2 = deterministicGate({
      text: rewritten,
      isGroup: params.isGroup,
      maxChars: params.maxChars,
      maxSentences: params.maxSentences,
      identityAntiPatterns: params.identityAntiPatterns,
    });
    if (!det2.pass) {
      return { reason: det2.reason ?? 'rewrite_deterministic_fail', attemptedRewrite: true };
    }

    const eval2 = await evaluateQualityBestEffort({
      backend: params.backend,
      kind: params.kind,
      draft: rewritten,
      isGroup: params.isGroup,
      maxChars: params.maxChars,
      maxSentences: params.maxSentences,
      userTextHint: params.userTextHint,
      identityAntiPatterns: params.identityAntiPatterns,
      signal: params.signal,
      takeModelToken: params.takeModelToken,
      recordUsage: params.recordUsage,
    });
    if (!eval2.pass) {
      return { verdict: eval2.verdict, reason: 'quality_gate_fail', attemptedRewrite: true };
    }
    return { text: rewritten, verdict: eval2.verdict, attemptedRewrite: true };
  }

  const eval1 = await evaluateQualityBestEffort({
    backend: params.backend,
    kind: params.kind,
    draft: disciplined,
    isGroup: params.isGroup,
    maxChars: params.maxChars,
    maxSentences: params.maxSentences,
    userTextHint: params.userTextHint,
    identityAntiPatterns: params.identityAntiPatterns,
    signal: params.signal,
    takeModelToken: params.takeModelToken,
    recordUsage: params.recordUsage,
  });
  if (eval1.pass) {
    return { text: disciplined, verdict: eval1.verdict, attemptedRewrite: false };
  }

  // One bounded rewrite attempt.
  const notes = eval1.verdict?.notes ?? eval1.reason ?? 'failed quality gate';
  const { system, user } = rewritePrompt({
    kind: params.kind,
    isGroup: params.isGroup,
    maxChars: params.maxChars,
    maxSentences: params.maxSentences,
    userTextHint: params.userTextHint,
    draft: disciplined,
    notes,
  });

  await params.takeModelToken?.();
  const rewrite = await params.backend.complete({
    role: 'fast',
    maxSteps: 1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.recordUsage?.({
    ...(rewrite.usage ? { usage: rewrite.usage } : {}),
    ...(rewrite.modelId ? { modelId: rewrite.modelId } : {}),
  });
  const rewritten = disciplineText(rewrite.text, {
    maxChars: params.maxChars,
    isGroup: params.isGroup,
  });

  const det2 = deterministicGate({
    text: rewritten,
    isGroup: params.isGroup,
    maxChars: params.maxChars,
    maxSentences: params.maxSentences,
    identityAntiPatterns: params.identityAntiPatterns,
  });
  if (!det2.pass) {
    return { reason: det2.reason ?? 'rewrite_deterministic_fail', attemptedRewrite: true };
  }

  const eval2 = await evaluateQualityBestEffort({
    backend: params.backend,
    kind: params.kind,
    draft: rewritten,
    isGroup: params.isGroup,
    maxChars: params.maxChars,
    maxSentences: params.maxSentences,
    userTextHint: params.userTextHint,
    identityAntiPatterns: params.identityAntiPatterns,
    signal: params.signal,
    takeModelToken: params.takeModelToken,
    recordUsage: params.recordUsage,
  });
  if (!eval2.pass) {
    return { verdict: eval2.verdict, reason: 'quality_gate_fail', attemptedRewrite: true };
  }

  return { text: rewritten, verdict: eval2.verdict, attemptedRewrite: true };
}
