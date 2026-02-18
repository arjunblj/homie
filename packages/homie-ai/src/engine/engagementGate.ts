import { z } from 'zod';

import type { IncomingMessage } from '../agent/types.js';
import type { CompletionResult, LLMBackend } from '../backend/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionStore } from '../session/types.js';
import type { OutgoingAction } from './types.js';

export type EngagementDecision =
  | { kind: 'send' }
  | { kind: 'silence'; reason?: string | undefined }
  | { kind: 'react'; emoji: string; reason?: string | undefined };

const EngagementDecisionSchema = z
  .object({
    action: z.enum(['send', 'react', 'silence']),
    emoji: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

export function extractJsonObject(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return JSON.parse(t) as unknown;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1)) as unknown;
  throw new Error('No JSON object found');
}

export async function decideGroupEngagement(opts: {
  backend: LLMBackend;
  sessionStore?: SessionStore | undefined;
  msg: IncomingMessage;
  userText: string;
  signal?: AbortSignal | undefined;
  onCompletion: (res: CompletionResult) => void;
}): Promise<EngagementDecision> {
  const { backend, sessionStore, msg, userText } = opts;

  const recent = sessionStore?.getMessages(msg.chatId, 25) ?? [];
  const lines = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map((m) => {
      if (m.role === 'assistant') return `FRIEND: ${m.content}`;
      const label = (m.authorDisplayName ?? m.authorId ?? 'USER').trim() || 'USER';
      return `${label}: ${m.content}`;
    });

  const sys = [
    'You decide whether a friend agent should engage in a group chat BEFORE drafting a reply.',
    'Most of the time the best move is to stay silent.',
    'Rules:',
    '- Prefer SILENCE if the message does not require a response.',
    '- Prefer REACT if a single emoji is enough.',
    '- Prefer SEND only if you have something genuinely additive or the user asked you directly.',
    '- Never output assistant-y language.',
    '- Output ONLY valid JSON (no code fences).',
    '',
    'JSON shape:',
    '{ "action": "send" | "react" | "silence", "emoji"?: "💀|😭|🔥|😂|💯|👍", "reason"?: string }',
  ].join('\n');

  const res = await backend.complete({
    role: 'fast',
    maxSteps: 2,
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: [
          `Mentioned: ${msg.mentioned ? 'true' : 'false'}`,
          `IsOperator: ${msg.isOperator ? 'true' : 'false'}`,
          `Incoming: ${userText}`,
          lines.length ? `Recent:\n${lines.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    signal: opts.signal,
  });
  opts.onCompletion(res);

  let raw: unknown;
  try {
    raw = extractJsonObject(res.text);
  } catch (_err) {
    return { kind: 'send' };
  }
  const parsed = EngagementDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'send' };
  }

  const d = parsed.data;
  if (d.action === 'silence') return { kind: 'silence', reason: d.reason ?? 'gate_silence' };
  if (d.action === 'react')
    return { kind: 'react', emoji: d.emoji?.trim() || '👍', reason: d.reason };
  return { kind: 'send' };
}

export async function persistImmediateGateAction(opts: {
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryStore | undefined;
  msg: IncomingMessage;
  userText: string;
  action: Exclude<EngagementDecision, { kind: 'send' }>;
}): Promise<OutgoingAction> {
  const { sessionStore, memoryStore, msg, userText, action } = opts;
  const nowMs = Date.now();

  if (action.kind === 'react') {
    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'assistant',
      content: `[REACTION] ${action.emoji}`,
      createdAtMs: nowMs,
    });
    if (memoryStore) {
      await memoryStore.logEpisode({
        chatId: msg.chatId,
        content: `USER: ${userText}\nFRIEND_REACTION: ${action.emoji}`,
        createdAtMs: nowMs,
      });
    }
    return {
      kind: 'react',
      emoji: action.emoji,
      targetAuthorId: msg.authorId,
      targetTimestampMs: msg.timestampMs,
    };
  }

  if (memoryStore) {
    await memoryStore.logLesson({
      category: 'silence_decision',
      content: action.reason ?? 'silence',
      createdAtMs: nowMs,
    });
  }
  return { kind: 'silence', reason: action.reason ?? 'silence' };
}
