import { z } from 'zod';
import type { IncomingMessage } from '../agent/types.js';
import type { CompletionResult, LLMBackend } from '../backend/types.js';
import type { HomieBehaviorConfig } from '../config/types.js';
import type { SessionStore } from '../session/types.js';
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

const fnv1a32 = (input: string): number => {
  // Fast, deterministic hash for stable "random" decisions.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const stableChance01 = (seed: string): number => fnv1a32(seed) / 2 ** 32;

export type EngagementDecision =
  | { kind: 'send' }
  | { kind: 'silence'; reason?: string | undefined }
  | { kind: 'react'; emoji: string; reason?: string | undefined };

export interface BehaviorEngineOptions {
  behavior: HomieBehaviorConfig;
  backend: LLMBackend;
  now?: (() => Date) | undefined;
  /** Random skip probability for anti-predictability. 0-1, default 0.12. */
  randomSkipRate?: number | undefined;
  /** Injected RNG for testing. Defaults to a deterministic per-message hash. */
  rng?: (() => number) | undefined;
}

const DEFAULT_RANDOM_SKIP_RATE = 0.12;

export class BehaviorEngine {
  private readonly now: () => Date;
  private readonly rng: (() => number) | undefined;
  private readonly skipRate: number;

  public constructor(private readonly options: BehaviorEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.rng = options.rng;
    this.skipRate = options.randomSkipRate ?? DEFAULT_RANDOM_SKIP_RATE;
  }

  public async decidePreDraft(
    msg: IncomingMessage,
    userText: string,
    options?: {
      sessionStore?: SessionStore | undefined;
      signal?: AbortSignal | undefined;
      onCompletion?: ((res: CompletionResult) => void) | undefined;
    },
  ): Promise<EngagementDecision> {
    if (isInSleepWindow(this.now(), this.options.behavior.sleep) && !msg.isOperator) {
      return { kind: 'silence', reason: 'sleep_mode' };
    }

    if (!msg.isGroup) return { kind: 'send' };

    const recent = options?.sessionStore?.getMessages(msg.chatId, 25) ?? [];

    // Domination check: suppress if we've been talking too much relative to group size.
    const recentForDomination = recent.slice(-20);
    if (recentForDomination.length >= 6) {
      const reactionWeight = 0.25;
      let total = 0;
      let ours = 0;
      for (const m of recentForDomination) {
        if (m.role === 'user') {
          total += 1;
          continue;
        }
        if (m.role === 'assistant') {
          const w =
            typeof m.content === 'string' && m.content.startsWith('[REACTION]')
              ? reactionWeight
              : 1;
          total += w;
          ours += w;
        }
      }
      const distinctAuthors = new Set(
        recentForDomination
          .filter((m) => m.role === 'user')
          .map((m) => m.authorId)
          .filter(Boolean),
      ).size;
      const groupSize = Math.max(2, distinctAuthors + 1);
      const shareThreshold = groupSize <= 4 ? 0.3 : groupSize <= 7 ? 0.2 : 0.15;
      if (total > 0 && ours / total > shareThreshold) {
        return { kind: 'silence', reason: 'domination_check' };
      }
    }
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
      '{ "action": "send" | "react" | "silence", "emoji"?: "💀|😭|🔥|❤️|👀|💯", "reason"?: string }',
    ].join('\n');

    const res = await this.options.backend.complete({
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
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    options?.onCompletion?.(res);

    let raw: unknown;
    try {
      raw = extractJsonObject(res.text);
    } catch (_parseErr) {
      // Gate failures should bias toward silence in groups; explicit mentions and operators
      // are exceptions so we don't miss direct questions.
      if (msg.isOperator || msg.mentioned === true) return { kind: 'send' };
      return { kind: 'silence', reason: 'gate_parse_failed' };
    }

    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) {
      if (msg.isOperator || msg.mentioned === true) return { kind: 'send' };
      return { kind: 'silence', reason: 'gate_parse_failed' };
    }

    const d = parsed.data;
    if (d.action === 'silence') return { kind: 'silence', reason: d.reason ?? 'gate_silence' };
    if (d.action === 'react') {
      return {
        kind: 'react',
        emoji: d.emoji?.trim() || '💀',
        ...(d.reason ? { reason: d.reason } : {}),
      };
    }

    // Anti-predictability: even if we'd send, sometimes stay silent.
    // Operators are exempt. Explicit mentions are exempt.
    const roll =
      this.rng?.() ?? stableChance01(`${String(msg.chatId)}|${String(msg.messageId)}|random_skip`);
    if (!msg.isOperator && msg.mentioned !== true && roll < this.skipRate) {
      return { kind: 'silence', reason: 'random_skip' };
    }

    return { kind: 'send' };
  }
}
