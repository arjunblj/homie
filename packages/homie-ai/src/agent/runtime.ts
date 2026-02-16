import { streamText } from 'ai';

import type { HomieConfig } from '../config/types.js';
import { loadIdentityPackage } from '../identity/load.js';
import { composeIdentityPrompt } from '../identity/prompt.js';
import type { ProviderRegistry } from '../llm/registry.js';
import type { ChatId } from '../types/ids.js';
import { TokenBucket } from '../util/tokenBucket.js';
import { PerKeyLock } from './lock.js';
import type { IncomingMessage, OutgoingMessage } from './types.js';

export interface SlopCheckResult {
  isSlop: boolean;
  reasons: string[];
}

export interface SlopDetector {
  check(text: string, msg: IncomingMessage): SlopCheckResult;
}

export interface AgentRuntimeOptions {
  config: HomieConfig;
  providers: ProviderRegistry;
  slopDetector?: SlopDetector;
  streamTextImpl?: typeof streamText;
}

export class AgentRuntime {
  private readonly lock = new PerKeyLock<ChatId>();
  private readonly slop: SlopDetector;
  private readonly limiter: TokenBucket;
  private readonly stream: typeof streamText;

  public constructor(private readonly options: AgentRuntimeOptions) {
    this.slop =
      options.slopDetector ??
      ({
        check: () => ({ isSlop: false, reasons: [] }),
      } satisfies SlopDetector);

    // Simple provider-level rate limiting; later we can key by provider+model.
    this.limiter = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    this.stream = options.streamTextImpl ?? streamText;
  }

  public async handleIncomingMessage(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    return this.lock.runExclusive(msg.chatId, async () => this.handleIncomingMessageLocked(msg));
  }

  private async handleIncomingMessageLocked(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    const { config, providers } = this.options;

    // Load identity fresh each turn (no watcher needed).
    const identity = await loadIdentityPackage(config.paths.identityDir);
    const identityPrompt = composeIdentityPrompt(identity, { maxTokens: 1600 });

    const maxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const baseSystem = [
      '=== FRIEND BEHAVIOR (built-in) ===',
      'You are a friend, not an assistant.',
      'Keep it natural and brief.',
      `Hard limit: reply must be <= ${maxChars} characters.`,
      '',
      identityPrompt,
    ].join('\n');

    const userText = msg.text.trim();
    if (!userText) return null;

    const modelRole = msg.isOperator ? providers.defaultModel : providers.defaultModel;
    const maxSteps = 20;
    const maxRegens = 1;

    let attempt = 0;
    let lastText = '';

    while (attempt <= maxRegens) {
      attempt += 1;

      await this.limiter.take(1);

      const result = this.stream({
        model: modelRole.model,
        providerOptions: modelRole.providerOptions as any,
        stopWhen: ({ steps }) => steps.length >= maxSteps,
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: userText },
        ],
      });

      const text = (await result.text).trim();
      lastText = text;

      if (!text) return null; // silence is valid

      // Enforce length as a hard safety check (behavior engine adds smarter logic later).
      const clipped = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;

      const slopResult = this.slop.check(clipped, msg);
      if (!slopResult.isSlop) {
        return { channel: msg.channel, chatId: msg.chatId, text: clipped };
      }

      if (attempt > maxRegens) break;
      // Regen nudge: do not add "assistant energy" or meta commentary.
      // We re-run with an extra system instruction.
      const regenSystem = `${baseSystem}\n\nRewrite the reply to remove AI slop. Be specific, casual, and human.`;
      const regen = this.stream({
        model: modelRole.model,
        providerOptions: modelRole.providerOptions as any,
        stopWhen: ({ steps }) => steps.length >= maxSteps,
        messages: [
          { role: 'system', content: regenSystem },
          { role: 'user', content: userText },
        ],
      });

      lastText = (await regen.text).trim();
      if (!lastText) return null;
      const clippedRegen =
        lastText.length > maxChars ? lastText.slice(0, maxChars).trimEnd() : lastText;
      const slop2 = this.slop.check(clippedRegen, msg);
      if (!slop2.isSlop) return { channel: msg.channel, chatId: msg.chatId, text: clippedRegen };
      // else loop ends
      break;
    }

    // If still slop, choose silence over emitting junk.
    return null;
  }
}
