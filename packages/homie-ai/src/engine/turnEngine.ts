import { z } from 'zod';

import { BehaviorEngine } from '../behavior/engine.js';
import { checkSlop, slopReasons } from '../behavior/slop.js';
import type { HomieConfig } from '../config/types.js';
import { loadIdentityPackage } from '../identity/load.js';
import { composeIdentityPrompt } from '../identity/prompt.js';
import { formatPersonaReminder } from '../identity/personality.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionStore } from '../session/types.js';
import { defineTool } from '../tools/define.js';
import type { ToolDef } from '../tools/types.js';
import type { ChatId } from '../types/ids.js';
import { TokenBucket } from '../util/tokenBucket.js';
import { PerKeyLock } from '../agent/lock.js';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { OutgoingAction } from './types.js';

export interface SlopCheckResult {
  isSlop: boolean;
  reasons: string[];
}

export interface SlopDetector {
  check(text: string, msg: IncomingMessage): SlopCheckResult;
}

export interface TurnEngineOptions {
  config: HomieConfig;
  backend: LLMBackend;
  tools?: readonly ToolDef[] | undefined;
  slopDetector?: SlopDetector | undefined;
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryStore | undefined;
  maxContextTokens?: number | undefined;
  behaviorEngine?: BehaviorEngine | undefined;
}

const truncate = (s: string, maxChars: number): string => {
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
};

const channelUserId = (msg: IncomingMessage): string => `${msg.channel}:${msg.authorId}`;

export class TurnEngine {
  private readonly lock = new PerKeyLock<ChatId>();
  private readonly limiter = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
  private readonly slop: SlopDetector;
  private readonly behavior: BehaviorEngine;

  public constructor(private readonly options: TurnEngineOptions) {
    this.slop =
      options.slopDetector ??
      ({
        check: (text: string) => {
          const r = checkSlop(text);
          return { isSlop: r.isSlop, reasons: slopReasons(r) };
        },
      } satisfies SlopDetector);

    this.behavior =
      options.behaviorEngine ??
      new BehaviorEngine({
        behavior: options.config.behavior,
        backend: options.backend,
      });
  }

  public async handleIncomingMessage(msg: IncomingMessage): Promise<OutgoingAction> {
    return this.lock.runExclusive(msg.chatId, async () => this.handleIncomingMessageLocked(msg));
  }

  private async handleIncomingMessageLocked(msg: IncomingMessage): Promise<OutgoingAction> {
    const { config, backend, tools, sessionStore, memoryStore } = this.options;

    const userText = msg.text.trim();
    if (!userText) return { kind: 'silence', reason: 'empty_input' };

    const nowMs = Date.now();

    const identity = await loadIdentityPackage(config.paths.identityDir);
    const identityPrompt = composeIdentityPrompt(identity, { maxTokens: 1600 });
    const personaReminder = formatPersonaReminder(identity.personality);

    // Persist the user's message before the LLM call. If the process crashes mid-turn,
    // we still keep continuity for the next run.
    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'user',
      content: userText,
      createdAtMs: nowMs,
    });

    // Relationship-aware compaction: preserve emotional content, promises, relationship facts.
    const maxContextTokens = this.options.maxContextTokens ?? 8_000;
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize: async (input) => {
          const summarySystem = [
            'Summarize the conversation so far for a FRIEND agent.',
            'Preserve: emotional content, promises/commitments, durable relationship facts, inside jokes.',
            'Discard: redundant greetings, mechanical details, and anything already captured as facts.',
            'Return a concise summary (no bullet lists unless necessary).',
          ].join('\n');

          await this.limiter.take(1);
          const res = await backend.complete({
            role: 'fast',
            maxSteps: 2,
            messages: [
              { role: 'system', content: summarySystem },
              { role: 'user', content: input },
            ],
          });
          return res.text;
        },
      });
    }

    const sessionMsgs = sessionStore?.getMessages(msg.chatId, 200) ?? [];
    const maybeLast = sessionMsgs.at(-1);
    const historyMsgs =
      maybeLast?.role === 'user' && maybeLast.content === userText
        ? sessionMsgs.slice(0, -1)
        : sessionMsgs;

    const systemFromSession = historyMsgs
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    const isModelHistoryMessage = (
      m: (typeof historyMsgs)[number],
    ): m is (typeof historyMsgs)[number] & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant';

    const historyForModel = historyMsgs
      .filter(isModelHistoryMessage)
      .map((m) => ({ role: m.role, content: m.content }));

    // Memory injection:
    // - If the memory store provides a server-built context pack (e.g. HTTP adapter to Madhav),
    //   prefer that over reconstructing context client-side.
    // - Otherwise, fall back to lightweight local retrieval.
    let memorySection = '';
    if (memoryStore) {
      if (memoryStore.getContextPack) {
        const pack = await memoryStore.getContextPack({
          query: userText,
          chatId: msg.chatId,
          channelType: msg.channel,
          participants: [channelUserId(msg)],
          maxChars: 6000,
        });
        if (pack.context.trim()) {
          memorySection = `\n\n=== MEMORY CONTEXT (DATA) ===\n${pack.context.trim()}\n`;
        }
      } else {
        const cid = channelUserId(msg);
        const person = await memoryStore.getPersonByChannelId(cid);
        const facts = person ? await memoryStore.getFacts(person.displayName) : [];
        const recent = await memoryStore.getRecentEpisodes(msg.chatId, 72);

        const lines: string[] = [];
        if (person) {
          lines.push(`Person: ${person.displayName} (${person.relationshipStage})`);
        }
        if (facts.length) {
          lines.push('Facts:');
          for (const f of facts.slice(-10)) {
            lines.push(`- ${truncate(f.content, 240)}`);
          }
        }
        if (recent.length) {
          lines.push('Recent episodes:');
          for (const e of recent.slice(-3)) {
            lines.push(`- ${truncate(e.content, 320)}`);
          }
        }
        if (lines.length) {
          memorySection = `\n\n=== MEMORY CONTEXT (DATA) ===\n${lines.join('\n')}\n`;
        }
      }
    }

    const maxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const baseSystem = [
      '=== FRIEND BEHAVIOR (built-in) ===',
      'You are a friend, not an assistant.',
      'Keep it natural and brief.',
      'In group chats: one message only, no bullet points, no numbered lists, no multi-paragraph replies.',
      'Never restate what someone just said. Add something new or stay silent.',
      'Silence is valid. React > reply when you have nothing substantive to add.',
      'Never mention tool failures, bugs, or technical issues in chat. Continue normally.',
      `Hard limit: reply must be <= ${maxChars} characters.`,
      '',
      identityPrompt,
      systemFromSession ? `\n\n=== SESSION NOTES (DATA) ===\n${systemFromSession}` : '',
      memorySection,
    ].join('\n');

    const modelRole = 'default';
    const maxSteps = 20;
    const maxRegens = 1;

    let attempt = 0;
    let lastText = '';

    while (attempt <= maxRegens) {
      attempt += 1;
      await this.limiter.take(1);

      const result = await backend.complete({
        role: modelRole,
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: baseSystem },
          ...historyForModel,
          { role: 'user', content: userText },
        ],
      });

      const text = result.text.trim();
      lastText = text;
      if (!text) return { kind: 'silence', reason: 'model_silence' };

      const clipped = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
      const disciplined = msg.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
      const slopResult = this.slop.check(clipped, msg);
      if (!slopResult.isSlop) return await this.persistAndReturnAction(msg, userText, disciplined);
      if (attempt > maxRegens) break;

      const regenSystem = `${baseSystem}\n\nRewrite the reply to remove AI slop. Be specific, casual, and human.`;
      await this.limiter.take(1);
      const regen = await backend.complete({
        role: modelRole,
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: regenSystem },
          { role: 'user', content: userText },
        ],
      });

      lastText = regen.text.trim();
      if (!lastText) return { kind: 'silence', reason: 'model_silence_regen' };
      const clippedRegen =
        lastText.length > maxChars ? lastText.slice(0, maxChars).trimEnd() : lastText;
      const disciplinedRegen = msg.isGroup ? clippedRegen.replace(/\s*\n+\s*/gu, ' ').trim() : clippedRegen;
      const slop2 = this.slop.check(clippedRegen, msg);
      if (!slop2.isSlop) return await this.persistAndReturnAction(msg, userText, disciplinedRegen);
      break;
    }

    return { kind: 'silence', reason: 'slop_unresolved' };
  }

  private async persistAndReturnAction(
    msg: IncomingMessage,
    userText: string,
    draftText: string,
  ): Promise<OutgoingAction> {
    const { backend, sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    const action = await this.behavior.decide(msg, draftText);

    if (action.kind === 'send_text') {
      sessionStore?.appendMessage({
        chatId: msg.chatId,
        role: 'assistant',
        content: action.text,
        createdAtMs: nowMs,
      });
      if (memoryStore) {
        await memoryStore.logEpisode({
          chatId: msg.chatId,
          content: `USER: ${userText}\nFRIEND: ${action.text}`,
          createdAtMs: nowMs,
        });
        if (memoryStore.kind !== 'http') {
          await this.extractAndStoreMemory({
            backend,
            memoryStore,
            msg,
            userText,
            assistantText: action.text,
          });
        }
      }
      return action;
    }

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
      return action;
    }

    // Silence: we intentionally don't append an assistant message, but we do log the decision.
    if (memoryStore) {
      await memoryStore.logLesson({
        category: 'silence_decision',
        content: action.reason ?? 'silence',
        createdAtMs: nowMs,
      });
    }
    return action;
  }

  private async extractAndStoreMemory(args: {
    backend: LLMBackend;
    memoryStore: MemoryStore;
    msg: IncomingMessage;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    const { backend, memoryStore, msg, userText, assistantText } = args;
    const nowMs = Date.now();

    const IngestSchema = z.object({
      facts: z
        .array(
          z.object({
            channelUserId: z.string().min(1).optional(),
            displayName: z.string().min(1).optional(),
            content: z.string().min(1).max(500),
            confidence: z.number().min(0).max(1).optional(),
          }),
        )
        .default([]),
      lessons: z
        .array(
          z.object({
            category: z.string().min(1).max(64),
            content: z.string().min(1).max(500),
          }),
        )
        .default([]),
    });

    const ingestTool: ToolDef = defineTool({
      name: 'memory_ingest',
      tier: 'safe',
      description:
        'Write durable relationship memory. Use for stable facts, preferences, commitments, and lessons. Do not include secrets.',
      inputSchema: IngestSchema,
      execute: async (input) => {
        for (const f of input.facts) {
          const cid = f.channelUserId ?? channelUserId(msg);
          const personId = `person:${cid}`;
          const displayName = f.displayName ?? msg.authorId;
          await memoryStore.trackPerson({
            id: personId,
            displayName,
            channel: msg.channel,
            channelUserId: cid,
            relationshipStage: 'new',
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          });
          await memoryStore.storeFact({
            personId,
            subject: displayName,
            content: f.content,
            createdAtMs: nowMs,
          });
        }
        for (const l of input.lessons) {
          await memoryStore.logLesson({
            category: l.category,
            content: l.content,
            createdAtMs: nowMs,
          });
        }
        return { ok: true, facts: input.facts.length, lessons: input.lessons.length };
      },
    });

    const extractorSystem = [
      'You extract durable memory for a friend agent.',
      'Rules:',
      '- Only store stable facts/preferences/commitments that help the friend act like a real person later.',
      '- Do NOT store secrets, API keys, or anything sensitive.',
      '- If unsure, store nothing.',
      'Call memory_ingest exactly once with any extracted facts/lessons.',
    ].join('\n');

    try {
      await this.limiter.take(1);
      await backend.complete({
        role: 'fast',
        maxSteps: 6,
        tools: [ingestTool],
        messages: [
          { role: 'system', content: extractorSystem },
          {
            role: 'user',
            content: `Conversation:\nUSER: ${userText}\nFRIEND: ${assistantText}`,
          },
        ],
      });
    } catch (err) {
      // Extraction failures must never break the main turn.
      const errMsg = err instanceof Error ? err.message : String(err);
      await memoryStore.logLesson({
        category: 'memory_extraction_error',
        content: errMsg,
        createdAtMs: nowMs,
      });
    }
  }
}

