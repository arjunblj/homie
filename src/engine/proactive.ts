import type { IncomingMessage } from '../agent/types.js';
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
import type { ToolDef } from '../tools/types.js';
import { asMessageId } from '../types/ids.js';
import type { Logger } from '../util/logger.js';
import { errorFields } from '../util/logger.js';
import type { BuiltModelContext, ContextBuilder } from './contextBuilder.js';
import { generateDisciplinedReply } from './generation.js';
import { type PersistenceDeps, persistAndReturnProactiveAction } from './persistence.js';
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
      ...(hooks
        ? {
            onCompaction: async (ctx) => {
              await hooks.emit('onSessionCompacted', ctx);
            },
          }
        : {}),
    });
  }

  const trustTier = await deps.resolveTrustTier(msg);
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

  let lastContextTelemetry: BuiltModelContext['contextTelemetry'] | undefined;
  const buildAndGenerate = async (): Promise<{
    text?: string;
    reason?: string;
    toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
  }> => {
    const ctx = await deps.contextBuilder.buildProactiveModelContext({
      msg,
      event,
      tools,
      toolsForMessage: deps.toolsForMessage,
      toolGuidance: buildToolGuidance,
      identityPrompt,
      behaviorOverride,
    });
    lastContextTelemetry = ctx.contextTelemetry;

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
      dataMessagesForModel: ctx.dataMessagesForModel,
      tools: ctx.toolsForModel,
      historyForModel: ctx.historyForModel,
      userMessages: [{ role: 'user', content: 'Send the proactive message now.' }],
      maxChars: ctx.maxChars,
      maxSteps: config.engine.generation.proactiveMaxSteps,
      maxRegens: config.engine.generation.maxRegens,
      identityAntiPatterns,
      takeModelToken: deps.takeModelToken,
      engineSignal: deps.signal,
    });
  };

  let reply: {
    text?: string;
    reason?: string;
    toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
  };
  try {
    reply = await buildAndGenerate();
  } catch (err) {
    if (isContextOverflowError(err) && sessionStore) {
      const hooks = deps.hooks;
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
        force: true,
        ...(hooks
          ? {
              onCompaction: async (ctx) => {
                await hooks.emit('onSessionCompacted', ctx);
              },
            }
          : {}),
      });
      reply = await buildAndGenerate();
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
  if (!trimmed || trimmed === 'HEARTBEAT_OK') {
    return {
      action: { kind: 'silence', reason: reply.reason ?? 'proactive_model_silence' },
      userText: event.subject,
      isGroup: msg.isGroup,
    };
  }

  const action = await persistAndReturnProactiveAction(
    deps.persistenceDeps,
    msg,
    event,
    trimmed,
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
