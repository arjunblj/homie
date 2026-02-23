import { z } from 'zod';
import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { ModelRole } from '../config/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { EventKind } from '../proactive/types.js';
import type { EpisodeId } from '../types/ids.js';
import { asPersonId } from '../types/ids.js';
import { errorFields, log } from '../util/logger.js';
import type { Embedder } from './embeddings.js';
import type { MemoryStore } from './store.js';

const FACT_CATEGORIES = [
  'preference',
  'personal',
  'plan',
  'professional',
  'relationship',
  'misc',
] as const satisfies readonly string[];

const FACT_TYPES = ['factual', 'preference', 'experiential', 'belief', 'goal'] as const;
const TEMPORAL_SCOPES = ['current', 'past', 'future', 'unknown'] as const;

const OPEN_LOOP_CATEGORIES = [
  'waiting_for_outcome',
  'upcoming_event',
  'active_decision',
  'social_commitment',
  'ongoing_effort',
] as const;
const EMOTIONAL_WEIGHTS = ['low', 'medium', 'high'] as const;

const ExtractionSchema = z.object({
  facts: z
    .array(
      z.object({
        content: z.string().describe('One atomic fact, present tense'),
        category: z.enum(FACT_CATEGORIES),
        factType: z.enum(FACT_TYPES).optional().default('factual'),
        temporalScope: z.enum(TEMPORAL_SCOPES).optional().default('unknown'),
        evidenceQuote: z
          .string()
          .optional()
          .default('')
          .describe('Exact substring from the USER message that supports the fact'),
      }),
    )
    .describe('Non-trivial, personal facts. Empty array for greetings/small talk.'),
  events: z
    .array(
      z.object({
        kind: z.enum(['reminder', 'birthday', 'anticipated'] as const),
        subject: z.string().min(1),
        triggerAtMs: z.number().int().positive(),
        recurrence: z.enum(['once', 'yearly']).nullable().default('once'),
        followUp: z.boolean().default(false),
      }),
    )
    .describe('Only when the USER explicitly mentions a date/time or birthday; otherwise empty.'),
  openLoops: z
    .array(
      z.object({
        subject: z.string().min(1).describe('Concise: "job interview", "doctor results"'),
        category: z.enum(OPEN_LOOP_CATEGORIES),
        emotionalWeight: z.enum(EMOTIONAL_WEIGHTS).default('low'),
        anchorDateMs: z.number().int().positive().nullable().default(null),
        evidenceQuote: z
          .string()
          .optional()
          .default('')
          .describe('Exact substring from the USER message that supports the open loop'),
        followUpQuestion: z
          .string()
          .min(1)
          .describe('Natural friend follow-up question, short and casual'),
      }),
    )
    .optional()
    .default([])
    .describe('Unresolved things worth following up on later. Empty array for small talk.'),
  resolutions: z
    .array(
      z.object({
        subject: z.string().min(1).describe('Which open loop got resolved (by subject)'),
        outcome: z.string().min(1).describe('What happened / resolution outcome'),
        sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']).default('neutral'),
        confidence: z.number().min(0).max(1).default(0.8),
      }),
    )
    .optional()
    .default([])
    .describe('Open loops that this USER message resolves. Empty if none.'),
  personUpdate: z
    .object({
      currentConcerns: z.array(z.string()).optional(),
      goals: z.array(z.string()).optional(),
      moodSignal: z.string().optional(),
      curiosityQuestions: z.array(z.string()).optional(),
    })
    .optional(),
});

const ReconciliationSchema = z.object({
  actions: z.array(
    z.object({
      type: z.enum(['add', 'update', 'delete', 'none']),
      existingIdx: z
        .number()
        .optional()
        .describe('Index of existing fact (0-based) for update/delete'),
      content: z.string(),
    }),
  ),
});

const VerificationSchema = z.object({
  verified: z.array(
    z.object({
      content: z.string(),
      supported: z.boolean(),
      reason: z.string(),
    }),
  ),
});

const VERIFICATION_SYSTEM = [
  'You verify whether extracted facts are actually supported by the conversation.',
  'For each fact, answer: is this fact directly supported by what the USER said?',
  'Also reject facts that fail the actionability test (not useful next week) or that misattribute speaker.',
  '',
  'Return JSON: { verified: [{ content: string, supported: boolean, reason: string }] }',
].join('\n');

const EXTRACTION_SYSTEM = [
  'You extract structured memories from a conversation between a user and their AI friend.',
  '',
  '## THE ACTIONABILITY TEST (apply to every extraction)',
  'Before including ANY fact, ask: "Would this help have a better conversation next week?"',
  '- YES: "works at Jane Street" → can reference their work',
  '- YES: "launching a protein bar brand" → can ask about it later',
  '- NO: "said good morning" → everyone does this, not memorable',
  '- NO: "participated in conversation" → says nothing useful',
  '',
  'Prefer FEWER, HIGHER-QUALITY extractions. 3 great facts > 10 mediocre ones.',
  '',
  '## Rules',
  '- ONLY extract from USER messages. Never attribute assistant statements as user facts.',
  '- Return empty arrays for greetings, small talk, and generic statements.',
  '- Facts must be atomic (one fact per entry) and in present tense.',
  "- Add factType: one of ['factual','preference','experiential','belief','goal'].",
  "- Add temporalScope: one of ['current','past','future','unknown'].",
  '- Every fact MUST include evidenceQuote: an exact substring copied from the USER message.',
  '- Extract events when the USER explicitly states a date/time, birthday, or anticipated future events.',
  "- Use kind 'anticipated' for future events the user mentions (interviews, exams, trips, deadlines). Set followUp: true for events where checking in afterward would be appropriate.",
  '',
  '## Open loops (unresolved future states)',
  'An open loop is something the USER mentions that has a pending outcome worth following up on.',
  'Ask: "Would a real friend naturally bring this up later?"',
  '',
  'Categories:',
  '- waiting_for_outcome: waiting to hear back, results, applications, approvals',
  '- upcoming_event: interview/exam/appointment/deadline coming up (with or without a date)',
  '- active_decision: choosing between options, deciding whether to move/quit/start',
  '- social_commitment: plans with someone (only if it seems real; avoid empty pleasantries)',
  '- ongoing_effort: job search, training, building something over weeks',
  '',
  'Rules:',
  '- Keep openLoops small: 0-2 per message max.',
  '- Every open loop MUST include evidenceQuote (exact substring from USER message).',
  '- For social_commitment: only include if it feels specific or repeated (avoid "we should hang sometime").',
  '',
  '## Resolution detection',
  'If the USER resolves a prior open loop (mentions the outcome), include it in resolutions.',
  '- Only include resolutions when confidence >= 0.7.',
  '- "still waiting" is NOT a resolution.',
  '',
  '## ALWAYS skip (hard rules)',
  '- Greetings/acknowledgments: "gm", "hi", "nice", "lol", "k", "true"',
  '- Transient states: "brb", "omw", "feeling tired", "just woke up"',
  '- Generic group membership: "Person is in group chat"',
  '- Unidentifiable people: unnamed, from photos only, pronouns without referents',
  '- Vague observations without specifics',
  '',
  '## Follow-up timing (for anticipated events)',
  '- job_interview/presentation: schedule followUp 3-5 days after',
  '- health/doctor: 5-7 days after',
  '- travel: 1-2 days after stated return date',
  '- purchase: 7-14 days after',
  '- exam/test/deadline: 1-2 days after',
  '',
  '## Person updates (personUpdate)',
  "- currentConcerns: things currently on the user's mind (worries, deadlines, immediate issues). Max 5.",
  '- goals: longer-term aspirations or plans the user mentions.',
  '- moodSignal: the user\'s current emotional tone (e.g. "stressed but determined", "excited", "tired").',
  '- curiosityQuestions: things YOU (the friend) would want to learn more about. Frame as questions.',
  '- Only include fields you can confidently infer. Omit personUpdate entirely for greetings/small talk.',
  '',
  '## Zero-fact examples',
  '- "Hi" → { facts: [], events: [] }',
  '- "What\'s up?" → { facts: [], events: [] }',
  '- "lol" → { facts: [], events: [] }',
  '- "That\'s interesting" → { facts: [], events: [] }',
  '- "gm" → { facts: [], events: [] }',
].join('\n');

const RECONCILIATION_SYSTEM = [
  'You reconcile newly extracted facts against existing facts in memory.',
  'For each new fact, decide:',
  '- ADD: genuinely new information not in existing facts',
  '- UPDATE: refines or corrects an existing fact (provide existingIdx)',
  '- DELETE: contradicts an existing fact that is now wrong (provide existingIdx)',
  '- NONE: already known, no action needed',
  '',
  'existingIdx is the 0-based index in the existing facts list.',
  'Be conservative: prefer NONE over ADD when information is already captured.',
].join('\n');

export interface MemoryExtractorDeps {
  readonly backend: LLMBackend;
  readonly store: MemoryStore;
  readonly embedder?: Embedder | undefined;
  readonly scheduler?: EventScheduler | undefined;
  readonly timezone?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface MemoryExtractor {
  extractAndReconcile(turn: {
    readonly msg: IncomingMessage;
    readonly userText: string;
    readonly assistantText?: string | undefined;
    readonly episodeId?: EpisodeId | undefined;
  }): Promise<void>;
}

export function createMemoryExtractor(deps: MemoryExtractorDeps): MemoryExtractor {
  const { backend, store, scheduler, timezone, signal } = deps;
  const logger = log.child({ component: 'memory_extractor' });

  type CandidateFact = {
    readonly content: string;
    readonly category: (typeof FACT_CATEGORIES)[number];
    readonly factType: (typeof FACT_TYPES)[number];
    readonly temporalScope: (typeof TEMPORAL_SCOPES)[number];
    readonly evidenceQuote: string;
  };

  type PersonUpdate = z.infer<typeof ExtractionSchema>['personUpdate'];

  const normalizeSpaces = (s: string): string => s.replace(/\s+/gu, ' ').trim();
  const normalizeFactKey = (s: string): string => normalizeSpaces(s).toLowerCase();

  const includesEvidenceQuote = (userText: string, evidenceQuote: string): boolean => {
    if (!evidenceQuote) return false;
    if (userText.includes(evidenceQuote)) return true;
    const nq = normalizeSpaces(evidenceQuote);
    const nu = normalizeSpaces(userText);
    if (!nq) return false;
    return nu.includes(nq);
  };

  const shouldSkipExtraction = (userText: string): boolean => {
    const t = userText.trim();
    // Only skip messages that are very unlikely to contain durable facts.
    // Important: don't drop short-but-high-signal facts ("I'm 25", "work at X").
    if (t.length < 8 && !/\d/u.test(t) && !/@/u.test(t)) return true;
    if (
      /^(gm|gn|hi|hey|yo|sup|lol|lmao|haha|nice|k|ok|yeah|yep|nah|nope|true|facts|fr|bet)\s*$/i.test(
        t,
      )
    )
      return true;
    if (/^[\p{Emoji}\s]+$/u.test(t)) return true;
    return false;
  };

  const likelyHasExtractableContent = (userText: string): boolean => {
    const t = userText.trim();
    if (!t) return false;
    if (/@|\d/u.test(t)) return true;
    // Time/event cues (reminders, birthdays, deadlines).
    if (
      /\b(remind|reminder|birthday|bday|anniversary|tomorrow|today|tonight|next|this\s+(week|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/i.test(
        t,
      ) ||
      /\b\d{1,2}:\d{2}\b/u.test(t)
    )
      return true;
    if (/\b[A-Z][a-z]{2,}\b/u.test(t)) return true;
    if (
      /\b(i|we|he|she|they)\s+(work|live|moved|started|left|joined|like|love|prefer|enjoy|hate|want|need|am|was|have|got)\b/i.test(
        t,
      )
    )
      return true;
    return false;
  };

  const assessConfidenceTier = (
    fact: CandidateFact,
    userText: string,
  ): 'high' | 'medium' | 'low' => {
    const quote = fact.evidenceQuote;
    const supported = includesEvidenceQuote(userText, quote);

    if (
      quote.length >= 15 &&
      supported &&
      (/[A-Z][a-z]/u.test(fact.content) || /\d{2,}/u.test(fact.content) || /@/u.test(fact.content))
    ) {
      return 'high';
    }

    if (
      quote.length < 10 ||
      !supported ||
      /\b(maybe|might|probably|i think|not sure)\b/i.test(quote)
    ) {
      return 'low';
    }

    return 'medium';
  };

  const verifyFacts = async (opts: {
    userText: string;
    assistantText: string;
    facts: readonly CandidateFact[];
  }): Promise<Set<string>> => {
    if (opts.facts.length <= 1) return new Set();

    const res = await backend.complete({
      role: 'fast' as ModelRole,
      maxSteps: 2,
      messages: [
        { role: 'system', content: VERIFICATION_SYSTEM },
        {
          role: 'user',
          content: [
            'Conversation:',
            `USER: ${opts.userText}`,
            opts.assistantText ? `FRIEND: ${opts.assistantText}` : '',
            '',
            'Facts to verify:',
            ...opts.facts.map((f, i) => `${i + 1}. ${f.content}`),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      signal,
    });

    const parsed = VerificationSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) return new Set();

    const unsupported = new Set<string>();
    for (const v of parsed.data.verified) {
      if (!v.supported) unsupported.add(normalizeFactKey(v.content));
    }
    return unsupported;
  };

  const extractCandidates = async (turn: {
    readonly userText: string;
    readonly assistantText: string;
    readonly nowMs: number;
    readonly pendingOpenLoops?: Array<{ subject: string; category: string }> | undefined;
  }): Promise<{
    facts: CandidateFact[];
    events: z.infer<typeof ExtractionSchema>['events'];
    openLoops: z.infer<typeof ExtractionSchema>['openLoops'];
    resolutions: z.infer<typeof ExtractionSchema>['resolutions'];
    personUpdate: PersonUpdate;
  } | null> => {
    const { userText, assistantText, nowMs, pendingOpenLoops } = turn;
    const extractionResult = await backend.complete({
      role: 'fast' as ModelRole,
      maxSteps: 2,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM },
        {
          role: 'user',
          content: [
            `Now (ms since epoch): ${nowMs}`,
            timezone ? `Timezone: ${timezone}` : '',
            pendingOpenLoops && pendingOpenLoops.length > 0
              ? `PendingOpenLoops: ${JSON.stringify(pendingOpenLoops.slice(0, 10))}`
              : '',
            '',
            assistantText
              ? `Conversation:\nUSER: ${userText}\nFRIEND: ${assistantText}`
              : `Conversation:\nUSER: ${userText}`,
            '',
            'Extract memories as JSON matching this schema:',
            '{ facts: [{ content, category, factType, temporalScope, evidenceQuote }], events: [{ kind, subject, triggerAtMs, recurrence, followUp? }], openLoops: [{ subject, category, emotionalWeight, anchorDateMs?, evidenceQuote, followUpQuestion }], resolutions: [{ subject, outcome, sentiment?, confidence? }], personUpdate?: { currentConcerns?, goals?, moodSignal?, curiosityQuestions? } }',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      signal,
    });

    const parsed = ExtractionSchema.safeParse(safeJsonParse(extractionResult.text));
    if (!parsed.success) {
      logger.info('extract.parse_failed', {
        userTextLen: userText.length,
        assistantTextLen: assistantText.length,
      });
      return null;
    }

    const { facts: rawFacts, events, openLoops, resolutions, personUpdate } = parsed.data;
    const facts: CandidateFact[] = rawFacts
      .map((f) => ({
        content: f.content.trim(),
        category: f.category,
        factType: f.factType,
        temporalScope: f.temporalScope,
        evidenceQuote: f.evidenceQuote.trim(),
      }))
      .filter((f) => f.content.length > 0 && f.evidenceQuote.length > 0)
      .filter((f) => f.evidenceQuote.length <= 200)
      .filter((f) => includesEvidenceQuote(userText, f.evidenceQuote));

    const loops = (openLoops ?? [])
      .map((l) => ({
        subject: l.subject.trim(),
        category: l.category,
        emotionalWeight: l.emotionalWeight,
        anchorDateMs: l.anchorDateMs,
        evidenceQuote: l.evidenceQuote.trim(),
        followUpQuestion: l.followUpQuestion.trim(),
      }))
      .filter(
        (l) =>
          l.subject.length > 0 &&
          l.followUpQuestion.length > 0 &&
          l.evidenceQuote.length > 0 &&
          includesEvidenceQuote(userText, l.evidenceQuote),
      )
      .filter((l) => l.evidenceQuote.length <= 200);

    const resolved = (resolutions ?? [])
      .map((r) => ({
        subject: r.subject.trim(),
        outcome: r.outcome.trim(),
        sentiment: r.sentiment,
        confidence: r.confidence,
      }))
      .filter((r) => r.subject.length > 0 && r.outcome.length > 0)
      .filter((r) => r.confidence >= 0.7);

    return { facts, events, openLoops: loops, resolutions: resolved, personUpdate };
  };

  const reconcileAndApply = async (opts: {
    readonly personId: ReturnType<typeof asPersonId>;
    readonly subject: string;
    readonly candidateFacts: readonly CandidateFact[];
    readonly nowMs: number;
    readonly userText: string;
    readonly assistantText: string;
  }): Promise<void> => {
    const { personId, subject, candidateFacts, nowMs, userText, assistantText } = opts;
    if (candidateFacts.length === 0) return;

    const reconciliationQuery = candidateFacts.map((f) => f.content).join(' ');
    const allExisting = await store.hybridSearchFacts(reconciliationQuery, 30);
    const existingFacts = allExisting.filter((f) => f.personId === personId);

    if (existingFacts.length === 0) {
      let unsupportedFacts = new Set<string>();
      if (candidateFacts.length > 1) {
        try {
          unsupportedFacts = await verifyFacts({
            userText,
            assistantText,
            facts: candidateFacts,
          });
        } catch (err) {
          logger.debug('verify.error', errorFields(err));
        }
      }
      for (const fact of candidateFacts) {
        if (unsupportedFacts.has(normalizeFactKey(fact.content))) {
          logger.debug('verify.filtered', { content: fact.content.slice(0, 50) });
          continue;
        }
        await store.storeFact({
          personId,
          subject,
          content: fact.content,
          category: fact.category,
          factType: fact.factType,
          temporalScope: fact.temporalScope,
          evidenceQuote: fact.evidenceQuote,
          confidenceTier: assessConfidenceTier(fact, userText),
          isCurrent: true,
          createdAtMs: nowMs,
        });
      }
      return;
    }

    const existingForPrompt = existingFacts.map((f, i) => `[${i}] ${f.content}`);
    const newForPrompt = candidateFacts.map((f) => `- ${f.content}`);
    const candidateByKey = new Map(candidateFacts.map((f) => [normalizeFactKey(f.content), f]));

    const reconcileResult = await backend.complete({
      role: 'fast' as ModelRole,
      maxSteps: 2,
      messages: [
        { role: 'system', content: RECONCILIATION_SYSTEM },
        {
          role: 'user',
          content: [
            'Existing facts:',
            ...existingForPrompt,
            '',
            'New candidate facts:',
            ...newForPrompt,
            '',
            'Return JSON: { actions: [{ type, existingIdx?, content }] }',
          ].join('\n'),
        },
      ],
      signal,
    });

    const reconciled = ReconciliationSchema.safeParse(safeJsonParse(reconcileResult.text));
    if (!reconciled.success) {
      logger.info('reconcile.parse_failed', {
        existingCount: existingFacts.length,
        candidateCount: candidateFacts.length,
      });

      const existingSet = new Set(existingFacts.map((f) => f.content.trim().toLowerCase()));
      for (const fact of candidateFacts) {
        const key = fact.content.trim().toLowerCase();
        if (existingSet.has(key)) continue;
        await store.storeFact({
          personId,
          subject,
          content: fact.content,
          category: fact.category,
          factType: fact.factType,
          temporalScope: fact.temporalScope,
          evidenceQuote: fact.evidenceQuote,
          confidenceTier: assessConfidenceTier(fact, userText),
          isCurrent: true,
          createdAtMs: nowMs,
        });
      }
      return;
    }

    const hasUpdatesOrDeletes = reconciled.data.actions.some(
      (a) => a.type === 'update' || a.type === 'delete',
    );
    const needsVerification = candidateFacts.length > 1 || hasUpdatesOrDeletes;

    let unsupportedFacts = new Set<string>();
    if (needsVerification) {
      try {
        unsupportedFacts = await verifyFacts({
          userText,
          assistantText,
          facts: candidateFacts,
        });
      } catch (err) {
        logger.debug('verify.error', errorFields(err));
      }
    }

    for (const action of reconciled.data.actions) {
      const key = normalizeFactKey(action.content);
      const candidate = candidateByKey.get(key);

      // Guardrail: never let reconciliation invent new content for add/update.
      if ((action.type === 'add' || action.type === 'update') && !candidate) {
        logger.debug('reconcile.non_candidate_ignored', {
          type: action.type,
          content: action.content.slice(0, 80),
        });
        continue;
      }
      if ((action.type === 'add' || action.type === 'update') && unsupportedFacts.has(key)) {
        logger.debug('verify.filtered', { content: action.content.slice(0, 50) });
        continue;
      }
      switch (action.type) {
        case 'add':
          await store.storeFact({
            personId,
            subject,
            content: candidate?.content ?? action.content,
            ...(candidate
              ? {
                  category: candidate.category,
                  factType: candidate.factType,
                  temporalScope: candidate.temporalScope,
                  evidenceQuote: candidate.evidenceQuote,
                  confidenceTier: assessConfidenceTier(candidate, userText),
                  isCurrent: true,
                }
              : { isCurrent: true }),
            createdAtMs: nowMs,
          });
          break;
        case 'update': {
          const idx = action.existingIdx;
          const existing = idx !== undefined ? existingFacts[idx] : undefined;
          if (existing?.id !== undefined && candidate) {
            await store.updateFact(existing.id, candidate.content);
          }
          break;
        }
        case 'delete': {
          const idx = action.existingIdx;
          const existing = idx !== undefined ? existingFacts[idx] : undefined;
          if (existing?.id !== undefined) {
            await store.setFactCurrent(existing.id, false);
          }
          break;
        }
        case 'none':
          break;
      }
    }
  };

  return {
    async extractAndReconcile(turn): Promise<void> {
      const { msg, userText } = turn;
      const assistantText = turn.assistantText ?? '';
      const nowMs = Date.now();

      const markExtractedBestEffort = async (): Promise<void> => {
        const episodeId = turn.episodeId;
        if (!episodeId) return;
        try {
          await store.markEpisodeExtracted(episodeId, nowMs);
        } catch (err) {
          logger.debug('episode.mark_extracted_failed', errorFields(err));
        }
      };

      if (shouldSkipExtraction(userText)) {
        await markExtractedBestEffort();
        return;
      }
      if (!likelyHasExtractableContent(userText)) {
        await markExtractedBestEffort();
        return;
      }
      const cid = channelUserId(msg);
      let person = await store.getPersonByChannelId(cid);
      const personId = person?.id ?? asPersonId(`person:${cid}`);
      if (!person) {
        await store.trackPerson({
          id: personId,
          displayName: msg.authorId,
          channel: msg.channel,
          channelUserId: cid,
          relationshipScore: 0,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        person = await store.getPersonByChannelId(cid);
      }
      const subject = person?.displayName ?? msg.authorId;

      const pendingOpenLoops =
        scheduler
          ?.listOpenLoopsForChat(msg.chatId, 10)
          .filter((l) => l.status === 'open')
          .map((l) => ({ subject: l.subject, category: 'open_loop' })) ?? [];

      let extracted: {
        facts: CandidateFact[];
        events: z.infer<typeof ExtractionSchema>['events'];
        openLoops: z.infer<typeof ExtractionSchema>['openLoops'];
        resolutions: z.infer<typeof ExtractionSchema>['resolutions'];
        personUpdate: PersonUpdate;
      } | null = null;
      try {
        extracted = await extractCandidates({ userText, assistantText, nowMs, pendingOpenLoops });
      } catch (err) {
        logger.error('extract.error', errorFields(err));
        return;
      }
      if (!extracted) return;
      await markExtractedBestEffort();

      const { facts: candidateFacts, events, openLoops, resolutions, personUpdate } = extracted;
      const hasWork =
        candidateFacts.length > 0 ||
        (scheduler && (events.length > 0 || openLoops.length > 0 || resolutions.length > 0)) ||
        personUpdate;
      if (!hasWork) return;

      if (scheduler && events.length > 0) {
        for (const ev of events) {
          const triggerAtMs = ev.triggerAtMs;
          if (!Number.isFinite(triggerAtMs)) continue;
          if (triggerAtMs < nowMs - 5 * 60_000) continue;
          if (triggerAtMs > nowMs + 366 * 24 * 60 * 60_000) continue;
          if (msg.isGroup && (ev.kind === 'reminder' || ev.kind === 'birthday')) continue;
          scheduler.addEvent({
            kind: ev.kind as EventKind,
            subject: ev.subject,
            chatId: msg.chatId,
            triggerAtMs,
            recurrence: ev.recurrence,
            createdAtMs: nowMs,
          });
          if (ev.followUp && ev.kind === 'anticipated') {
            const followUpMs = triggerAtMs + 36 * 60 * 60_000; // ~1.5 days after (safer than early)
            scheduler.addEvent({
              kind: 'follow_up' as EventKind,
              subject: `follow up: ${ev.subject}`,
              chatId: msg.chatId,
              triggerAtMs: followUpMs,
              recurrence: 'once',
              createdAtMs: nowMs,
            });
          }
        }
      }

      const normalizeOpenLoopKey = (s: string): string => {
        return s
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 80);
      };
      const jitterMs = (minMs: number, maxMs: number): number => {
        const min = Math.max(0, Math.floor(minMs));
        const max = Math.max(min, Math.floor(maxMs));
        return min + Math.floor(Math.random() * (max - min + 1));
      };
      const computeFollowUpAtMs = (l: (typeof openLoops)[number]): number => {
        const day = 86_400_000;
        if (l.category === 'upcoming_event' && typeof l.anchorDateMs === 'number') {
          return l.anchorDateMs + day + jitterMs(2 * 60 * 60_000, 18 * 60 * 60_000);
        }
        if (l.category === 'waiting_for_outcome') {
          const base = l.emotionalWeight === 'high' ? 3 : l.emotionalWeight === 'medium' ? 4 : 6;
          return nowMs + base * day + jitterMs(0, 18 * 60 * 60_000);
        }
        if (l.category === 'active_decision') {
          return nowMs + 7 * day + jitterMs(0, 2 * day);
        }
        if (l.category === 'social_commitment') {
          return nowMs + 10 * day + jitterMs(0, 4 * day);
        }
        return nowMs + 21 * day + jitterMs(0, 7 * day);
      };

      if (scheduler && resolutions.length > 0) {
        for (const r of resolutions) {
          const subjectKey = normalizeOpenLoopKey(r.subject);
          if (!subjectKey) continue;
          const resolvedRes = scheduler.resolveOpenLoop({
            chatId: msg.chatId,
            subjectKey,
            nowMs,
          });
          if (resolvedRes.resolved && resolvedRes.followUpEventId) {
            scheduler.cancelEvent(resolvedRes.followUpEventId);
          }
        }
      }

      if (scheduler && openLoops.length > 0) {
        for (const l of openLoops) {
          const subjectKey = normalizeOpenLoopKey(l.subject);
          if (!subjectKey) continue;

          const upsert = scheduler.upsertOpenLoop({
            chatId: msg.chatId,
            subject: l.subject,
            subjectKey,
            category: l.category,
            emotionalWeight: l.emotionalWeight,
            anchorDateMs: l.anchorDateMs,
            evidenceQuote: l.evidenceQuote,
            followUpQuestion: l.followUpQuestion,
            nowMs,
          });

          if (
            l.category === 'social_commitment' &&
            l.emotionalWeight === 'low' &&
            upsert.mentionCount < 2
          ) {
            continue;
          }
          if (upsert.followUpEventId) continue;

          const followUpAtMs = computeFollowUpAtMs(l);
          if (followUpAtMs < nowMs + 12 * 60 * 60_000) continue;
          if (followUpAtMs > nowMs + 90 * 86_400_000) continue;

          const eventId = scheduler.addEvent({
            kind: 'follow_up' as EventKind,
            subject: l.followUpQuestion,
            chatId: msg.chatId,
            triggerAtMs: followUpAtMs,
            recurrence: 'once',
            createdAtMs: nowMs,
          });
          if (eventId) {
            scheduler.attachFollowUpEventToOpenLoop({
              openLoopId: upsert.openLoopId,
              followUpEventId: eventId,
            });
          }
        }
      }

      try {
        await reconcileAndApply({
          personId,
          subject,
          candidateFacts,
          nowMs,
          userText,
          assistantText,
        });
      } catch (err) {
        logger.error('reconcile.error', errorFields(err));
      }

      if (personUpdate) {
        try {
          await store.updateStructuredPersonData(personId, {
            currentConcerns: personUpdate.currentConcerns,
            goals: personUpdate.goals,
            lastMoodSignal: personUpdate.moodSignal,
            curiosityQuestions: personUpdate.curiosityQuestions,
          });
        } catch (err) {
          logger.error('person_update.error', errorFields(err));
        }
      }
    },
  };
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    // Try extracting JSON from markdown code fences or surrounding text
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (_err2) {
        return undefined;
      }
    }
    return undefined;
  }
}
