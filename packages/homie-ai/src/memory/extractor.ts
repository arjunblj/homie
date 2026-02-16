import { z } from 'zod';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { ModelRole } from '../config/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { EventKind } from '../proactive/types.js';
import { asPersonId } from '../types/ids.js';
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
      }),
    )
    .describe('Non-trivial, personal facts. Empty array for greetings/small talk.'),
  events: z
    .array(
      z.object({
        kind: z.enum(['reminder', 'birthday'] as const),
        subject: z.string().min(1),
        triggerAtMs: z.number().int().positive(),
        recurrence: z.enum(['once', 'yearly']).nullable().default('once'),
      }),
    )
    .describe('Only when the USER explicitly mentions a date/time or birthday; otherwise empty.'),
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

const EXTRACTION_SYSTEM = [
  'You extract structured memories from a conversation between a user and their AI friend.',
  '',
  'Rules:',
  '- ONLY extract from USER messages. Never attribute assistant statements as user facts.',
  '- Return empty arrays for greetings, small talk, and generic statements.',
  '- Facts must be atomic (one fact per entry) and in present tense.',
  '- Only extract events when the USER explicitly states a date/time or birthday. Never guess.',
  '',
  'Examples of conversations that produce ZERO facts:',
  '- "Hi" → { facts: [], events: [] }',
  '- "What\'s up?" → { facts: [], events: [] }',
  '- "lol" → { facts: [], events: [] }',
  '- "That\'s interesting" → { facts: [], events: [] }',
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
}

export interface MemoryExtractor {
  extractAndReconcile(turn: {
    readonly msg: IncomingMessage;
    readonly userText: string;
    readonly assistantText: string;
  }): Promise<void>;
}

function channelUserId(msg: IncomingMessage): string {
  return `${msg.channel}:${msg.authorId}`;
}

export function createMemoryExtractor(deps: MemoryExtractorDeps): MemoryExtractor {
  const { backend, store, scheduler, timezone } = deps;

  return {
    async extractAndReconcile(turn): Promise<void> {
      const { msg, userText, assistantText } = turn;
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
          relationshipStage: 'new',
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        person = await store.getPersonByChannelId(cid);
      }
      const subject = person?.displayName ?? msg.authorId;

      // Pass 1: Extract candidate facts
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
              `Conversation:\nUSER: ${userText}\nFRIEND: ${assistantText}`,
              '',
              'Extract memories as JSON matching this schema:',
              '{ facts: [{ content, category }], events: [{ kind, subject, triggerAtMs, recurrence }] }',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });

      const parsed = ExtractionSchema.safeParse(safeJsonParse(extractionResult.text));
      if (
        !parsed.success ||
        (parsed.data.facts.length === 0 && (!scheduler || parsed.data.events.length === 0))
      ) {
        return;
      }

      const { facts: candidateFacts, events } = parsed.data;

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
        }
      }

      // Pass 2: Reconcile against existing facts
      const reconciliationQuery = candidateFacts.map((f) => f.content).join(' ');
      const allExisting = store.hybridSearchFacts
        ? await store.hybridSearchFacts(reconciliationQuery, 30)
        : await store.searchFacts(reconciliationQuery, 30);
      const existingFacts = allExisting.filter((f) => f.personId === personId);

      if (existingFacts.length === 0) {
        // No existing facts to reconcile -- just add all candidates
        for (const fact of candidateFacts) {
          await store.storeFact({
            personId,
            subject,
            content: fact.content,
            createdAtMs: nowMs,
          });
        }
        return;
      }

      // Present existing facts with sequential indices (not real IDs)
      const existingForPrompt = existingFacts.map((f, i) => `[${i}] ${f.content}`);
      const newForPrompt = candidateFacts.map((f) => `- ${f.content}`);

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
      });

      const reconciled = ReconciliationSchema.safeParse(safeJsonParse(reconcileResult.text));
      if (!reconciled.success) {
        // Reconciliation parse failed -- fall back to adding all candidates
        for (const fact of candidateFacts) {
          await store.storeFact({
            personId,
            subject,
            content: fact.content,
            createdAtMs: nowMs,
          });
        }
        return;
      }

      // Execute reconciliation actions
      for (const action of reconciled.data.actions) {
        switch (action.type) {
          case 'add':
            await store.storeFact({
              personId,
              subject,
              content: action.content,
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
    },
  };
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try extracting JSON from markdown code fences or surrounding text
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
