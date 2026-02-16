import { z } from 'zod';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { ModelRole } from '../config/types.js';
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
        subject: z.string().describe('Who/what this is about (display name if a person)'),
        content: z.string().describe('One atomic fact, present tense'),
        category: z.enum(FACT_CATEGORIES),
      }),
    )
    .describe('Non-trivial, personal facts. Empty array for greetings/small talk.'),
  people: z
    .array(
      z.object({
        displayName: z.string(),
        mentionedRelationship: z.string().optional(),
      }),
    )
    .describe('People mentioned by the user, not the assistant.'),
});

const ReconciliationSchema = z.object({
  actions: z.array(
    z.object({
      type: z.enum(['add', 'update', 'delete', 'none']),
      existingIdx: z
        .number()
        .optional()
        .describe('Index of existing fact (0-based) for update/delete'),
      subject: z.string(),
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
  '- People must be real people mentioned by the user.',
  '',
  'Examples of conversations that produce ZERO facts:',
  '- "Hi" → { facts: [], people: [] }',
  '- "What\'s up?" → { facts: [], people: [] }',
  '- "lol" → { facts: [], people: [] }',
  '- "That\'s interesting" → { facts: [], people: [] }',
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
  const { backend, store } = deps;

  return {
    async extractAndReconcile(turn): Promise<void> {
      const { msg, userText, assistantText } = turn;
      const nowMs = Date.now();

      // Pass 1: Extract candidate facts and people
      const extractionResult = await backend.complete({
        role: 'fast' as ModelRole,
        maxSteps: 2,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM },
          {
            role: 'user',
            content: `Conversation:\nUSER: ${userText}\nFRIEND: ${assistantText}\n\nExtract memories as JSON matching this schema: { facts: [{ subject, content, category }], people: [{ displayName, mentionedRelationship? }] }`,
          },
        ],
      });

      const parsed = ExtractionSchema.safeParse(safeJsonParse(extractionResult.text));
      if (!parsed.success || (parsed.data.facts.length === 0 && parsed.data.people.length === 0)) {
        return;
      }

      const { facts: candidateFacts, people } = parsed.data;

      // Track mentioned people
      const cid = channelUserId(msg);
      for (const person of people) {
        const personId = `person:${msg.channel}:${person.displayName.toLowerCase().replace(/\s+/gu, '-')}`;
        await store.trackPerson({
          id: asPersonId(personId),
          displayName: person.displayName,
          channel: msg.channel,
          channelUserId: cid,
          relationshipStage: 'new',
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
      }

      if (candidateFacts.length === 0) return;

      // Pass 2: Reconcile against existing facts
      const existingFacts = await store.searchFacts(
        candidateFacts.map((f) => f.content).join(' '),
        20,
      );

      if (existingFacts.length === 0) {
        // No existing facts to reconcile -- just add all candidates
        for (const fact of candidateFacts) {
          const personId = `person:${cid}`;
          await store.storeFact({
            personId: asPersonId(personId),
            subject: fact.subject,
            content: fact.content,
            createdAtMs: nowMs,
          });
        }
        return;
      }

      // Present existing facts with sequential indices (not real IDs)
      const existingForPrompt = existingFacts.map((f, i) => `[${i}] ${f.subject}: ${f.content}`);
      const newForPrompt = candidateFacts.map((f) => `- ${f.subject}: ${f.content}`);

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
              'Return JSON: { actions: [{ type, existingIdx?, subject, content }] }',
            ].join('\n'),
          },
        ],
      });

      const reconciled = ReconciliationSchema.safeParse(safeJsonParse(reconcileResult.text));
      if (!reconciled.success) {
        // Reconciliation parse failed -- fall back to adding all candidates
        for (const fact of candidateFacts) {
          await store.storeFact({
            personId: asPersonId(`person:${cid}`),
            subject: fact.subject,
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
              personId: asPersonId(`person:${cid}`),
              subject: action.subject,
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
