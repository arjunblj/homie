import { z } from 'zod';
import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { ModelRole } from '../config/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { EventKind } from '../proactive/types.js';
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

const ExtractionSchema = z.object({
  facts: z
    .array(
      z.object({
        content: z.string().describe('One atomic fact, present tense'),
        category: z.enum(FACT_CATEGORIES),
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
  '- Every fact MUST include evidenceQuote: an exact substring copied from the USER message.',
  '- Extract events when the USER explicitly states a date/time, birthday, or anticipated future events.',
  "- Use kind 'anticipated' for future events the user mentions (interviews, exams, trips, deadlines). Set followUp: true for events where checking in afterward would be appropriate.",
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
  }): Promise<void>;
}

export function createMemoryExtractor(deps: MemoryExtractorDeps): MemoryExtractor {
  const { backend, store, scheduler, timezone, signal } = deps;
  const logger = log.child({ component: 'memory_extractor' });

  type CandidateFact = {
    readonly content: string;
    readonly category: (typeof FACT_CATEGORIES)[number];
    readonly evidenceQuote: string;
  };

  type PersonUpdate = z.infer<typeof ExtractionSchema>['personUpdate'];

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
      if (!v.supported) unsupported.add(v.content);
    }
    return unsupported;
  };

  const extractCandidates = async (turn: {
    readonly userText: string;
    readonly assistantText: string;
    readonly nowMs: number;
  }): Promise<{
    facts: CandidateFact[];
    events: z.infer<typeof ExtractionSchema>['events'];
    personUpdate: PersonUpdate;
  } | null> => {
    const { userText, assistantText, nowMs } = turn;
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
            '',
            assistantText
              ? `Conversation:\nUSER: ${userText}\nFRIEND: ${assistantText}`
              : `Conversation:\nUSER: ${userText}`,
            '',
            'Extract memories as JSON matching this schema:',
            '{ facts: [{ content, category, evidenceQuote }], events: [{ kind, subject, triggerAtMs, recurrence, followUp? }], personUpdate?: { currentConcerns?, goals?, moodSignal?, curiosityQuestions? } }',
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

    const { facts: rawFacts, events, personUpdate } = parsed.data;
    const facts: CandidateFact[] = rawFacts
      .map((f) => ({
        content: f.content.trim(),
        category: f.category,
        evidenceQuote: f.evidenceQuote.trim(),
      }))
      .filter((f) => f.content.length > 0 && f.evidenceQuote.length > 0)
      .filter((f) => f.evidenceQuote.length <= 200)
      .filter((f) => userText.includes(f.evidenceQuote));

    return { facts, events, personUpdate };
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
        if (unsupportedFacts.has(fact.content)) {
          logger.debug('verify.filtered', { content: fact.content.slice(0, 50) });
          continue;
        }
        await store.storeFact({
          personId,
          subject,
          content: fact.content,
          category: fact.category,
          evidenceQuote: fact.evidenceQuote,
          createdAtMs: nowMs,
        });
      }
      return;
    }

    const existingForPrompt = existingFacts.map((f, i) => `[${i}] ${f.content}`);
    const newForPrompt = candidateFacts.map((f) => `- ${f.content}`);
    const candidateByContent = new Map(candidateFacts.map((f) => [f.content, f]));

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
          evidenceQuote: fact.evidenceQuote,
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
      if (action.type === 'add' && unsupportedFacts.has(action.content)) {
        logger.debug('verify.filtered', { content: action.content.slice(0, 50) });
        continue;
      }
      switch (action.type) {
        case 'add':
          await store.storeFact({
            personId,
            subject,
            content: action.content,
            ...(candidateByContent.get(action.content)
              ? {
                  category: candidateByContent.get(action.content)?.category,
                  evidenceQuote: candidateByContent.get(action.content)?.evidenceQuote,
                }
              : {}),
            createdAtMs: nowMs,
          });
          break;
        case 'update': {
          const idx = action.existingIdx;
          const existing = idx !== undefined ? existingFacts[idx] : undefined;
          if (existing?.id !== undefined) {
            await store.updateFact(existing.id, action.content);
          }
          break;
        }
        case 'delete': {
          const idx = action.existingIdx;
          const existing = idx !== undefined ? existingFacts[idx] : undefined;
          if (existing?.id !== undefined) {
            await store.deleteFact(existing.id);
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

      let extracted: {
        facts: CandidateFact[];
        events: z.infer<typeof ExtractionSchema>['events'];
        personUpdate: PersonUpdate;
      } | null = null;
      try {
        extracted = await extractCandidates({ userText, assistantText, nowMs });
      } catch (err) {
        logger.error('extract.error', errorFields(err));
        return;
      }
      if (!extracted) return;

      const { facts: candidateFacts, events, personUpdate } = extracted;
      const hasWork = candidateFacts.length > 0 || (scheduler && events.length > 0) || personUpdate;
      if (!hasWork) return;

      if (scheduler && events.length > 0 && !msg.isGroup) {
        for (const ev of events) {
          const triggerAtMs = ev.triggerAtMs;
          if (!Number.isFinite(triggerAtMs)) continue;
          if (triggerAtMs < nowMs - 5 * 60_000) continue;
          if (triggerAtMs > nowMs + 366 * 24 * 60 * 60_000) continue;
          scheduler.addEvent({
            kind: ev.kind as EventKind,
            subject: ev.subject,
            chatId: msg.chatId,
            triggerAtMs,
            recurrence: ev.recurrence,
            createdAtMs: nowMs,
          });
          if (ev.followUp && ev.kind === 'anticipated') {
            const followUpMs = triggerAtMs + 24 * 60 * 60_000; // 1 day after
            scheduler.addEvent({
              kind: 'follow_up' as EventKind,
              subject: `Follow up: ${ev.subject}`,
              chatId: msg.chatId,
              triggerAtMs: followUpMs,
              recurrence: 'once',
              createdAtMs: nowMs,
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
  } catch (err) {
    void err;
    // Try extracting JSON from markdown code fences or surrounding text
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (err2) {
        void err2;
        return undefined;
      }
    }
    return undefined;
  }
}
