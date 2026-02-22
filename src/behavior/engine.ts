import { z } from 'zod';
import type { IncomingMessage } from '../agent/types.js';
import type { CompletionResult, LLMBackend } from '../backend/types.js';
import type { OpenhomieBehaviorConfig } from '../config/types.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import {
  classifyMessageType,
  computeHeatFromStats,
  computeParticipationStats,
  detectThreadLock,
  participationRateToTarget,
  shouldSilenceForDomination,
} from './groupEngagement.js';
import { DEFAULT_REACTION_POOL, NEVER_USE, pickWeightedReaction } from './reactions.js';
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
  behavior: OpenhomieBehaviorConfig;
  backend: LLMBackend;
  now?: (() => Date) | undefined;
  /** Injected RNG for testing. Defaults to a deterministic per-message hash. */
  rng?: (() => number) | undefined;
}

const DEFAULT_ALLOWED_REACTION_EMOJIS = new Set(
  DEFAULT_REACTION_POOL.filter((e) => !NEVER_USE.has(e.emoji)).map((e) => e.emoji),
);

export class BehaviorEngine {
  private readonly now: () => Date;
  private readonly rng: (() => number) | undefined;

  public constructor(private readonly options: BehaviorEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.rng = options.rng;
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

    if (msg.isOperator) return { kind: 'send' };

    const recent = options?.sessionStore?.getMessages(msg.chatId, 25) ?? [];

    const messageType = classifyMessageType(msg, userText);
    if (messageType === 'mentioned_question') return { kind: 'send' };
    const stats = computeParticipationStats(recent);

    const nowMs = this.now().getTime();
    const heat = computeHeatFromStats(stats, nowMs);
    const participationRate = participationRateToTarget(stats);

    const domination = stats.totalRecentCount >= 6 && shouldSilenceForDomination(stats);
    const threadLock = detectThreadLock(recent);
    const disallowSendReason = threadLock
      ? 'thread_lock'
      : domination
        ? 'domination_check'
        : undefined;
    const allowSend = !disallowSendReason;

    return await this.decideViaLlmGate(msg, userText, recent, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.onCompletion ? { onCompletion: options.onCompletion } : {}),
      allowSend,
      ...(disallowSendReason ? { disallowSendReason } : {}),
      messageType,
      heat: heat.heat,
      participationRate,
    });
  }

  private roll01(msg: IncomingMessage, salt: string): number {
    const v = this.rng?.();
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v <= 0) return 0;
      if (v >= 1) return 1;
      return v;
    }
    return stableChance01(`${String(msg.chatId)}|${String(msg.messageId)}|${salt}`);
  }

  private async decideViaLlmGate(
    msg: IncomingMessage,
    userText: string,
    recent: SessionMessage[],
    options?: {
      signal?: AbortSignal | undefined;
      onCompletion?: ((res: CompletionResult) => void) | undefined;
      allowSend?: boolean | undefined;
      disallowSendReason?: string | undefined;
      messageType?: string | undefined;
      heat?: number | undefined;
      participationRate?: number | undefined;
    },
  ): Promise<EngagementDecision> {
    const lines = recent
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => {
        if (m.role === 'assistant') return `FRIEND: ${m.content}`;
        const label = (m.authorDisplayName ?? m.authorId ?? 'USER').trim() || 'USER';
        return `${label}: ${m.content}`;
      });

    const allowSend = options?.allowSend !== false;
    const sys = [
      'You decide whether a friend agent should engage in a group chat BEFORE drafting a reply.',
      'You are optimizing for: high-quality engagement with minimal spam.',
      '',
      'Rules:',
      '- Default to SILENCE in groups unless engaging would be clearly valuable.',
      '- Prefer REACT if a single emoji is enough.',
      '- Choose SEND only if you have something genuinely additive and non-repetitive.',
      '- If not mentioned: be even more conservative about SEND.',
      '- Never restate, summarize, or paraphrase what was just said.',
      '- Never quote linked content.',
      '- Never output assistant-y language.',
      '- Output ONLY valid JSON (no code fences).',
      '',
      'Constraints:',
      `- AllowedActions: ${allowSend ? 'send, react, silence' : 'react, silence'}`,
      `- AllowedReactionEmojis: ${[...DEFAULT_ALLOWED_REACTION_EMOJIS].join(' ')}`,
      '',
      'JSON shape:',
      '{ "action": "send" | "react" | "silence", "emoji"?: string, "reason"?: string }',
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
            `MessageType: ${options?.messageType ?? 'unknown'}`,
            `Heat: ${typeof options?.heat === 'number' ? options.heat.toFixed(3) : 'unknown'}`,
            `ParticipationRate: ${
              typeof options?.participationRate === 'number'
                ? options.participationRate.toFixed(3)
                : 'unknown'
            }`,
            `AllowSend: ${allowSend ? 'true' : 'false'}`,
            ...(options?.disallowSendReason
              ? [`DisallowSendReason: ${options.disallowSendReason}`]
              : []),
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
      // Gate failures should bias toward send for explicit mentions (we don't want to miss).
      if (msg.mentioned === true) return { kind: 'send' };
      return { kind: 'silence', reason: 'gate_parse_failed' };
    }

    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) {
      if (msg.mentioned === true) return { kind: 'send' };
      return { kind: 'silence', reason: 'gate_parse_failed' };
    }

    const d = parsed.data;
    if (d.action === 'silence') return { kind: 'silence', reason: d.reason ?? 'gate_silence' };
    if (d.action === 'react') {
      const candidate = d.emoji?.trim();
      const emoji =
        candidate && DEFAULT_ALLOWED_REACTION_EMOJIS.has(candidate) && !NEVER_USE.has(candidate)
          ? candidate
          : undefined;
      return {
        kind: 'react',
        emoji:
          emoji ?? pickWeightedReaction(DEFAULT_REACTION_POOL, this.roll01(msg, 'reaction_emoji')),
        ...(d.reason ? { reason: d.reason } : {}),
      };
    }
    if (!allowSend) {
      return { kind: 'silence', reason: options?.disallowSendReason ?? 'send_disallowed' };
    }
    return { kind: 'send' };
  }
}
