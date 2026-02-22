import { z } from 'zod';
import type { IncomingMessage } from '../agent/types.js';
import type { CompletionResult, LLMBackend } from '../backend/types.js';
import type { OpenhomieBehaviorConfig } from '../config/types.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import {
  classifyMessageType,
  computeHeat,
  computeParticipationStats,
  detectThreadLock,
  participationRateToTarget,
  rollEngagement,
  shouldSilenceForDomination,
} from './groupEngagement.js';
import { DEFAULT_REACTION_POOL, pickWeightedReaction } from './reactions.js';
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

    if (msg.isOperator) return { kind: 'send' };

    const recent = options?.sessionStore?.getMessages(msg.chatId, 25) ?? [];
    const stats = computeParticipationStats(recent);

    // 1) Domination check (existing)
    if (stats.totalRecentCount >= 6 && shouldSilenceForDomination(stats)) {
      return { kind: 'silence', reason: 'domination_check' };
    }

    // 2) Thread lock check (new)
    if (detectThreadLock(recent)) {
      return { kind: 'silence', reason: 'thread_lock' };
    }

    // 3) Mentions: only call the fast model for ambiguous mentions.
    const messageType = classifyMessageType(msg, userText);
    if (messageType === 'mentioned_question') return { kind: 'send' };
    if (messageType === 'mentioned_casual') {
      return await this.decideViaLlmGate(msg, userText, recent, options);
    }

    // 4) Unmentioned group messages: deterministic engagement routing (no LLM calls).
    const nowMs = this.now().getTime();
    const heat = computeHeat(recent, nowMs);
    const participationRate = participationRateToTarget(stats);
    const engagementRoll = this.roll01(msg, 'engagement_roll');
    const action = rollEngagement(heat.heat, messageType, participationRate, engagementRoll);

    if (action === 'silence') return { kind: 'silence', reason: 'engagement_silence' };
    if (action === 'react') {
      const emoji = pickWeightedReaction(DEFAULT_REACTION_POOL, this.roll01(msg, 'reaction_emoji'));
      return { kind: 'react', emoji, reason: 'engagement_react' };
    }

    // 5) Anti-predictability: even if we'd send, sometimes stay silent.
    // Operators are exempt. Explicit mentions are exempt.
    const skipRoll = this.roll01(msg, 'random_skip');
    if (msg.mentioned !== true && skipRoll < this.skipRate) {
      return { kind: 'silence', reason: 'random_skip' };
    }

    return { kind: 'send' };
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

    const sys = [
      'You decide whether a friend agent should engage in a group chat BEFORE drafting a reply.',
      'The user mentioned the friend, but it may not require a response.',
      'Rules:',
      '- Prefer SILENCE if no response is needed.',
      '- Prefer REACT if a single emoji is enough.',
      '- Prefer SEND only if you have something genuinely additive or the user asked you directly.',
      '- Never output assistant-y language.',
      '- Output ONLY valid JSON (no code fences).',
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
    return { kind: 'send' };
  }
}
