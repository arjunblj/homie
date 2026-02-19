import { z } from 'zod';
import type { IncomingMessage } from '../agent/types.js';
import type { CompletionResult, LLMBackend } from '../backend/types.js';
import type { HomieBehaviorConfig } from '../config/types.js';
import type { OutgoingAction } from '../engine/types.js';
import { isInSleepWindow } from './timing.js';

const DecisionSchema = z
  .object({
    action: z.enum(['send', 'react', 'silence']),
    emoji: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

const extractJsonObject = (text: string): unknown => {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return JSON.parse(t) as unknown;

  // Best-effort: find the first JSON object in the output.
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(t.slice(start, end + 1)) as unknown;
  }
  throw new Error('No JSON object found in decision output');
};

export interface BehaviorEngineOptions {
  behavior: HomieBehaviorConfig;
  backend: LLMBackend;
  now?: (() => Date) | undefined;
  /** Random skip probability for anti-predictability. 0-1, default 0.12. */
  randomSkipRate?: number | undefined;
  /** Injected RNG for testing. Defaults to Math.random. */
  rng?: (() => number) | undefined;
}

const DEFAULT_RANDOM_SKIP_RATE = 0.12;

export class BehaviorEngine {
  private readonly now: () => Date;
  private readonly rng: () => number;
  private readonly skipRate: number;

  public constructor(private readonly options: BehaviorEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.rng = options.rng ?? Math.random;
    this.skipRate = options.randomSkipRate ?? DEFAULT_RANDOM_SKIP_RATE;
  }

  public async decide(
    msg: IncomingMessage,
    draftText: string,
    options?: {
      signal?: AbortSignal | undefined;
      onCompletion?: ((res: CompletionResult) => void) | undefined;
    },
  ): Promise<OutgoingAction> {
    if (isInSleepWindow(this.now(), this.options.behavior.sleep) && !msg.isOperator) {
      return { kind: 'silence', reason: 'sleep_mode' };
    }

    // Anti-predictability: randomly skip some group messages even when all conditions say "respond".
    // Operators are exempt. DMs are exempt (friends reply to DMs).
    if (msg.isGroup && !msg.isOperator && this.rng() < this.skipRate) {
      return { kind: 'silence', reason: 'random_skip' };
    }

    if (!msg.isGroup) return { kind: 'send_text', text: draftText };

    // Groups: decide between send/react/silence using the fast model.
    // This keeps friend behavior aligned with \"silence is valid\" and react-vs-reply.
    const sys = [
      'You decide whether a friend agent should send a message, react, or stay silent in a group chat.',
      'Rules:',
      '- Prefer SILENCE if the reply would be redundant, restating, or not worth saying.',
      '- Prefer REACT if there is nothing substantive to add (one emoji reaction is enough).',
      '- Prefer SEND only if it adds a real point or a good one-liner.',
      '- Do not use assistant-y language.',
      '- Output ONLY valid JSON (no code fences).',
      '',
      'JSON shape:',
      '{ "action": "send" | "react" | "silence", "emoji"?: "💀|😭|🔥|😂|💯|👍", "reason"?: string }',
    ].join('\n');

    const res = await this.options.backend.complete({
      role: 'fast',
      maxSteps: 2,
      messages: [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: [
            `Incoming: ${msg.text}`,
            `DraftReply: ${draftText}`,
            `IsOperator: ${msg.isOperator ? 'true' : 'false'}`,
          ].join('\n'),
        },
      ],
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    options?.onCompletion?.(res);

    let raw: unknown;
    try {
      raw = extractJsonObject(res.text);
    } catch (_parseErr) {
      return { kind: 'send_text', text: draftText } as const;
    }

    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'send_text', text: draftText };

    const d = parsed.data;
    if (d.action === 'silence') return { kind: 'silence', reason: d.reason ?? 'group_silence' };
    if (d.action === 'react') {
      const emoji = d.emoji?.trim() || '👍';
      return {
        kind: 'react',
        emoji,
        targetAuthorId: msg.authorId,
        targetTimestampMs: msg.timestampMs,
      };
    }
    return { kind: 'send_text', text: draftText };
  }
}
