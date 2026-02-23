import type { IncomingMessage } from '../agent/types.js';
import { gateOutgoingText } from '../behavior/qualityGate.js';
import { isInSleepWindow } from '../behavior/timing.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { HookRegistry } from '../hooks/registry.js';
import type { MemoryStore } from '../memory/store.js';
import type { ChatTrustTier } from '../memory/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { ProactiveEvent } from '../proactive/types.js';
import type { TelemetryStore } from '../telemetry/types.js';
import { buildToolGuidance } from '../tools/policy.js';
import type { ToolDef, ToolMediaAttachment } from '../tools/types.js';
import { asMessageId } from '../types/ids.js';
import type { Logger } from '../util/logger.js';
import { errorFields } from '../util/logger.js';
import type { BuiltModelContext, ContextBuilder } from './contextBuilder.js';
import { generateDisciplinedReply } from './generation.js';
import { type PersistenceDeps, persistAndReturnProactiveAction } from './persistence.js';
import { buildScratchpadDataMessage } from './scratchpadContext.js';
import type { OutgoingAction, UsageAcc } from './types.js';

const inferProactiveRecipientMessage = (event: ProactiveEvent): IncomingMessage | null => {
  const parsed = parseChatId(event.chatId);
  const nowMs = Date.now();

  if (parsed?.channel === 'signal' && parsed.kind === 'dm') {
    const authorId = parsed.id;
    return {
      channel: 'signal',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId,
      authorDisplayName: undefined,
      text: '',
      isGroup: false,
      isOperator: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'signal' && parsed.kind === 'group') {
    return {
      channel: 'signal',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId: `group:${parsed.id}`,
      authorDisplayName: undefined,
      text: '',
      isGroup: true,
      isOperator: false,
      mentioned: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'telegram' && parsed.kind === 'dm') {
    const authorId = parsed.id;
    return {
      channel: 'telegram',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId,
      authorDisplayName: undefined,
      text: '',
      isGroup: false,
      isOperator: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'telegram' && parsed.kind === 'group') {
    return {
      channel: 'telegram',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId: `group:${parsed.id}`,
      authorDisplayName: undefined,
      text: '',
      isGroup: true,
      isOperator: false,
      mentioned: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'cli') {
    return {
      channel: 'cli',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId: 'operator',
      authorDisplayName: 'operator',
      text: '',
      isGroup: false,
      isOperator: true,
      timestampMs: nowMs,
    };
  }
  return null;
};

export interface ProactiveDeps {
  turnId: string;
  config: OpenhomieConfig;
  memoryStore: MemoryStore | undefined;
  tools: readonly ToolDef[] | undefined;
  contextBuilder: ContextBuilder;
  logger: Logger;
  eventScheduler: EventScheduler | undefined;
  persistenceDeps: PersistenceDeps;
  backend: import('../backend/types.js').LLMBackend;
  sessionStore: import('../session/types.js').SessionStore | undefined;
  maxContextTokens: number | undefined;
  signal: AbortSignal | undefined;
  hooks?: HookRegistry | undefined;
  telemetry?: TelemetryStore | undefined;
  toolsForMessage: (
    msg: IncomingMessage,
    tools: readonly ToolDef[] | undefined,
  ) => readonly ToolDef[] | undefined;
  resolveTrustTier: (msg: IncomingMessage) => Promise<ChatTrustTier>;
  takeModelToken: (chatId: IncomingMessage['chatId']) => Promise<void>;
  summarizeForCompaction: (msg: IncomingMessage, usage: UsageAcc, input: string) => Promise<string>;
}

export async function handleProactiveEventLocked(
  deps: ProactiveDeps,
  event: ProactiveEvent,
  usage: UsageAcc,
): Promise<{
  action: OutgoingAction;
  userText: string;
  responseText?: string | undefined;
  isGroup: boolean;
}> {
  const msg = inferProactiveRecipientMessage(event);
  if (!msg) {
    deps.logger.warn('proactive.unroutable', {
      chatId: String(event.chatId),
      proactiveEventId: event.id,
      proactiveKind: event.kind,
    });
    return {
      action: { kind: 'silence', reason: 'proactive_unroutable' },
      userText: event.subject,
      isGroup: false,
    };
  }

  const { config, tools, sessionStore } = deps;
  const nowMs = Date.now();

  if (isInSleepWindow(new Date(nowMs), config.behavior.sleep) && !msg.isOperator) {
    return {
      action: { kind: 'silence', reason: 'sleep_mode' },
      userText: event.subject,
      isGroup: msg.isGroup,
    };
  }

  const trustTier = await deps.resolveTrustTier(msg);
  if (!msg.isGroup) {
    if (trustTier === 'new_contact' && event.kind !== 'reminder' && event.kind !== 'birthday') {
      return {
        action: { kind: 'silence', reason: 'proactive_safe_mode' },
        userText: event.subject,
        isGroup: msg.isGroup,
      };
    }
    if (trustTier === 'getting_to_know' && event.kind !== 'reminder' && event.kind !== 'birthday') {
      const dailySent = deps.eventScheduler?.countRecentSendsForChat(event.chatId, 86_400_000);
      if ((dailySent ?? 0) >= 1) {
        return {
          action: { kind: 'silence', reason: 'proactive_warming_throttle' },
          userText: event.subject,
          isGroup: msg.isGroup,
        };
      }
    }
  } else {
    // Group proactivity is allowed, but only when the group is established and not currently active.
    // The group capsule is group-safe and gives the model context for a non-weird follow-up.
    const minQuietMs = 5 * 60_000;
    const lastUserMessageMs = (() => {
      const msgs = sessionStore?.getMessages(msg.chatId, 50) ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      return lastUser?.createdAtMs;
    })();
    if (lastUserMessageMs && nowMs - lastUserMessageMs < minQuietMs) {
      return {
        action: { kind: 'silence', reason: 'proactive_active_chat' },
        userText: event.subject,
        isGroup: msg.isGroup,
      };
    }
    if (deps.memoryStore) {
      const episodes = await deps.memoryStore.countEpisodes(msg.chatId);
      if (episodes < 10) {
        return {
          action: { kind: 'silence', reason: 'proactive_group_insufficient_history' },
          userText: event.subject,
          isGroup: msg.isGroup,
        };
      }
      const capsule = await deps.memoryStore.getGroupCapsule(msg.chatId);
      if (!capsule?.trim()) {
        return {
          action: { kind: 'silence', reason: 'proactive_group_no_capsule' },
          userText: event.subject,
          isGroup: msg.isGroup,
        };
      }
    }
  }

  const { identityPrompt, personaReminder, behaviorOverride, identityAntiPatterns } =
    await deps.contextBuilder.buildIdentityContext();

  const maxContextTokens = deps.maxContextTokens ?? config.engine.context.maxTokensDefault;
  const summarize = (input: string): Promise<string> =>
    deps.summarizeForCompaction(msg, usage, input);
  if (sessionStore) {
    const hooks = deps.hooks;
    await sessionStore.compactIfNeeded({
      chatId: msg.chatId,
      maxTokens: maxContextTokens,
      personaReminder,
      summarize,
      onCompaction: async (ctx) => {
        try {
          sessionStore.upsertNote({
            chatId: ctx.chatId,
            key: 'notes.last_compaction_summary',
            content: ctx.summary,
            nowMs: Date.now(),
          });
        } catch (err) {
          deps.logger.debug('session.write_compaction_note_failed', errorFields(err));
        }
        if (hooks) await hooks.emit('onSessionCompacted', ctx);
      },
    });
  }

  let lastContextTelemetry: BuiltModelContext['contextTelemetry'] | undefined;
  let lastMaxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
  const buildAndGenerate = async (
    sendInstruction: string,
    options?: { maxRegens?: number | undefined } | undefined,
  ): Promise<{
    text?: string;
    reason?: string;
    toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
    media?: readonly ToolMediaAttachment[] | undefined;
  }> => {
    // Proactive texts should not use tools unless the operator explicitly wants it.
    const toolsForGeneration = msg.isOperator ? tools : undefined;
    const ctx = await deps.contextBuilder.buildProactiveModelContext({
      msg,
      event,
      tools: toolsForGeneration,
      toolsForMessage: deps.toolsForMessage,
      toolGuidance: buildToolGuidance,
      identityPrompt,
      behaviorOverride,
    });
    lastContextTelemetry = ctx.contextTelemetry;
    lastMaxChars = ctx.maxChars;
    const scratchpadMsg = buildScratchpadDataMessage({ sessionStore, chatId: msg.chatId });
    const dataMessagesForModel = scratchpadMsg
      ? [scratchpadMsg, ...ctx.dataMessagesForModel]
      : ctx.dataMessagesForModel;

    const hooks = deps.hooks;
    if (hooks) {
      const sessionMsgs =
        sessionStore?.getMessages(msg.chatId, config.engine.session.fetchLimit) ?? [];
      await hooks.emit('onBeforeGenerate', {
        chatId: msg.chatId,
        messages: sessionMsgs,
        isGroup: msg.isGroup,
      });
    }

    return await generateDisciplinedReply({
      backend: deps.backend,
      usage,
      msg,
      system: ctx.system,
      dataMessagesForModel,
      tools: ctx.toolsForModel,
      historyForModel: ctx.historyForModel,
      userMessages: [{ role: 'user', content: sendInstruction }],
      maxChars: ctx.maxChars,
      maxSteps: config.engine.generation.proactiveMaxSteps,
      // Proactive is explicitly bounded by our own gates (sentence cap + slop gate).
      // Avoid internal slop regen loops here to keep total LLM calls predictable.
      maxRegens: options?.maxRegens ?? 0,
      skipSlopCheck: true,
      identityAntiPatterns,
      toolServices: { memoryStore: deps.memoryStore, sessionStore },
      takeModelToken: deps.takeModelToken,
      engineSignal: deps.signal,
    });
  };

  let reply: {
    text?: string;
    reason?: string;
    toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
    media?: readonly ToolMediaAttachment[] | undefined;
  };
  try {
    reply = await buildAndGenerate('Send the proactive message now.');
  } catch (err) {
    if (isContextOverflowError(err) && sessionStore) {
      const hooks = deps.hooks;
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
        force: true,
        onCompaction: async (ctx) => {
          try {
            sessionStore.upsertNote({
              chatId: ctx.chatId,
              key: 'notes.last_compaction_summary',
              content: ctx.summary,
              nowMs: Date.now(),
            });
          } catch (err2) {
            deps.logger.debug('session.write_compaction_note_failed', errorFields(err2));
          }
          if (hooks) await hooks.emit('onSessionCompacted', ctx);
        },
      });
      reply = await buildAndGenerate('Send the proactive message now.');
    } else {
      throw err;
    }
  }

  try {
    if (lastContextTelemetry) {
      deps.telemetry?.logContextComposition({
        turnId: deps.turnId,
        kind: 'proactive',
        chatId: String(msg.chatId),
        isGroup: msg.isGroup,
        trustTier,
        createdAtMs: nowMs,
        systemTokens: lastContextTelemetry.systemTokens,
        identityTokens: lastContextTelemetry.identityTokens,
        sessionNotesTokens: lastContextTelemetry.sessionNotesTokens,
        memoryTokens: lastContextTelemetry.memoryTokens,
        outboundLedgerTokens: lastContextTelemetry.outboundLedgerTokens,
        toolOutputTokens: reply.toolOutput?.tokensUsed ?? 0,
        toolOutputToolCalls: reply.toolOutput?.toolCalls ?? 0,
        toolOutputTruncatedCount: reply.toolOutput?.truncatedCount ?? 0,
        memorySkipped: lastContextTelemetry.memorySkipped,
      });
    }
  } catch (err) {
    deps.logger.debug('telemetry.logContextComposition_failed', errorFields(err));
  }

  const trimmed = reply.text?.trim() ?? '';
  let chosenMedia: readonly ToolMediaAttachment[] | undefined = reply.media;
  const isHeartbeatOk = /^HEARTBEAT_OK\b/u.test(trimmed);
  if (!trimmed || isHeartbeatOk) {
    if (event.kind === 'reminder' || event.kind === 'birthday') {
      const fallback =
        event.kind === 'birthday' ? 'happy birthday :)' : `reminder: ${event.subject}`.trim();
      const action = await persistAndReturnProactiveAction(
        deps.persistenceDeps,
        msg,
        event,
        fallback,
        undefined,
        nowMs,
      );
      return {
        action,
        userText: event.subject,
        responseText: action.kind === 'send_text' ? action.text : undefined,
        isGroup: msg.isGroup,
      };
    }
    return {
      action: { kind: 'silence', reason: reply.reason ?? 'proactive_model_silence' },
      userText: event.subject,
      isGroup: msg.isGroup,
    };
  }

  const recordUsage = (r: { usage?: import('../backend/types.js').LLMUsage; modelId?: string }) => {
    usage.addCompletion({
      text: '',
      steps: [],
      ...(r.modelId ? { modelId: r.modelId } : {}),
      usage: r.usage,
    });
  };

  const gated = await gateOutgoingText({
    backend: deps.backend,
    kind: 'proactive',
    draft: trimmed,
    maxChars: lastMaxChars,
    isGroup: msg.isGroup,
    identityAntiPatterns,
    maxSentences: 3,
    userTextHint: event.subject,
    signal: deps.signal,
    takeModelToken: async () => await deps.takeModelToken(msg.chatId),
    recordUsage,
  });
  if (!gated.text) {
    if (event.kind === 'reminder' || event.kind === 'birthday') {
      const fallback =
        event.kind === 'birthday' ? 'happy birthday :)' : `reminder: ${event.subject}`.trim();
      const action = await persistAndReturnProactiveAction(
        deps.persistenceDeps,
        msg,
        event,
        fallback,
        undefined,
        nowMs,
      );
      return {
        action,
        userText: event.subject,
        responseText: action.kind === 'send_text' ? action.text : undefined,
        isGroup: msg.isGroup,
      };
    }
    return {
      action: { kind: 'silence', reason: gated.reason ?? 'proactive_quality_gate' },
      userText: event.subject,
      isGroup: msg.isGroup,
    };
  }

  const draft = gated.text;
  if (gated.attemptedRewrite) chosenMedia = undefined;

  const action = await persistAndReturnProactiveAction(
    deps.persistenceDeps,
    msg,
    event,
    draft,
    chosenMedia,
    nowMs,
  );
  return {
    action,
    userText: event.subject,
    responseText: action.kind === 'send_text' ? action.text : undefined,
    isGroup: msg.isGroup,
  };
}

function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /context(\s|_)?(length|window)|prompt is too long|too many tokens|max tokens/i.test(msg);
}
