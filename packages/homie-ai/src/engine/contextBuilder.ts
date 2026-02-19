import { channelUserId, type IncomingMessage } from '../agent/types.js';
import { buildFriendBehaviorRules } from '../behavior/friendRules.js';
import type { HomieConfig } from '../config/types.js';
import { loadIdentityPackage } from '../identity/load.js';
import { formatPersonaReminder } from '../identity/personality.js';
import { composeIdentityPrompt } from '../identity/prompt.js';
import { assembleMemoryContext } from '../memory/context-pack.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProactiveEvent } from '../proactive/types.js';
import type { SessionStore } from '../session/types.js';
import type { ToolDef } from '../tools/types.js';
import { wrapExternal } from '../tools/util.js';
import { truncateToTokenBudget } from '../util/tokens.js';

const SESSION_NOTES_TOKEN_BUDGET = 400;

export type ToolsForMessage = (
  msg: IncomingMessage,
  tools: readonly ToolDef[] | undefined,
) => readonly ToolDef[] | undefined;

export type ToolGuidance = (tools: readonly ToolDef[] | undefined) => string;

export interface IdentityContext {
  readonly identityPrompt: string;
  readonly personaReminder: string;
  readonly behaviorOverride?: string | undefined;
}

export interface BuiltModelContext {
  readonly toolsForModel: readonly ToolDef[] | undefined;
  readonly historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
  readonly system: string;
  readonly dataMessagesForModel: Array<{ role: 'user'; content: string }>;
  readonly maxChars: number;
}

const buildSessionContext = (
  sessionStore: SessionStore | undefined,
  msg: IncomingMessage,
  fetchLimit: number,
  currentUserText?: string | undefined,
): {
  systemFromSession: string;
  historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
  groupSizeEstimate: number;
} => {
  const sessionMsgs = sessionStore?.getMessages(msg.chatId, fetchLimit) ?? [];

  // In incoming-message turns we persist the user message before the LLM call.
  // Avoid doubling it in the model history if it matches the current userText.
  const maybeLast = sessionMsgs.at(-1);
  const historyMsgs =
    currentUserText && maybeLast?.role === 'user' && maybeLast.content === currentUserText
      ? sessionMsgs.slice(0, -1)
      : sessionMsgs;

  const groupSizeEstimate = msg.isGroup
    ? new Set(
        sessionMsgs
          .filter((m) => m.role === 'user')
          .map((m) => m.authorId)
          .filter(Boolean),
      ).size
    : 1;

  const systemFromSession = historyMsgs
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();

  const isModelHistoryMessage = (
    m: (typeof historyMsgs)[number],
  ): m is (typeof historyMsgs)[number] & { role: 'user' | 'assistant' } =>
    m.role === 'user' || m.role === 'assistant';

  const sanitizeGroupAuthorLabel = (raw: string): string => {
    const oneLine = raw.replace(/\s+/gu, ' ').trim();
    const noBrackets = oneLine.replaceAll('[', '').replaceAll(']', '').trim();
    // Keep a conservative charset to avoid injection-y tokens like `SYSTEM:` or role prefixes.
    const safe = noBrackets
      .replace(/[^\p{L}\p{N} ._-]+/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    return safe.slice(0, 48).trim();
  };

  const renderHistoryContent = (m: (typeof historyMsgs)[number]): string => {
    if (!msg.isGroup) return m.content;
    if (m.role !== 'user') return m.content;

    const label = sanitizeGroupAuthorLabel(m.authorDisplayName ?? m.authorId ?? '');
    if (!label) return m.content;
    return `[from ${label}] ${m.content}`;
  };

  const historyForModel = historyMsgs
    .filter(isModelHistoryMessage)
    .map((m) => ({ role: m.role, content: renderHistoryContent(m) }));

  return { systemFromSession, historyForModel, groupSizeEstimate };
};

const buildMemorySection = async (opts: {
  config: HomieConfig;
  memoryStore?: MemoryStore | undefined;
  msg: IncomingMessage;
  query: string;
}): Promise<string> => {
  const { config, memoryStore, msg, query } = opts;
  if (!memoryStore || !config.memory.enabled) return '';

  const context = await assembleMemoryContext({
    store: memoryStore,
    query,
    chatId: msg.chatId,
    channelUserId: channelUserId(msg),
    budget: config.memory.contextBudgetTokens,
    scope: msg.isGroup ? 'group' : 'dm',
    capsuleEnabled: config.memory.capsule.enabled,
    capsuleMaxTokens: config.memory.capsule.maxTokens,
  });
  return context.text ? context.text : '';
};

const buildDataMessages = (
  sessionNotes: string,
  memorySection: string,
): Array<{ role: 'user'; content: string }> => {
  const out: Array<{ role: 'user'; content: string }> = [];
  if (sessionNotes) {
    out.push({
      role: 'user',
      content: wrapExternal(
        'session_notes',
        truncateToTokenBudget(sessionNotes, SESSION_NOTES_TOKEN_BUDGET),
      ),
    });
  }
  if (memorySection) {
    out.push({
      role: 'user',
      content: wrapExternal('memory_context', memorySection),
    });
  }
  return out;
};

export class ContextBuilder {
  public constructor(
    private readonly deps: {
      config: HomieConfig;
      sessionStore?: SessionStore | undefined;
      memoryStore?: MemoryStore | undefined;
      promptSkillsSection?: ((opts: { msg: IncomingMessage; query: string }) => string) | undefined;
    },
  ) {}

  public async buildIdentityContext(): Promise<IdentityContext> {
    const { config } = this.deps;
    const identity = await loadIdentityPackage(config.paths.identityDir);
    const identityPrompt = composeIdentityPrompt(identity, {
      maxTokens: config.engine.context.identityPromptMaxTokens,
    });
    const personaReminder = formatPersonaReminder(identity.personality);
    return {
      identityPrompt,
      personaReminder,
      ...(identity.behavior ? { behaviorOverride: identity.behavior } : {}),
    };
  }

  public async buildReactiveModelContext(opts: {
    msg: IncomingMessage;
    userText: string;
    tools: readonly ToolDef[] | undefined;
    toolsForMessage: ToolsForMessage;
    toolGuidance: ToolGuidance;
    identityPrompt: string;
    behaviorOverride?: string | undefined;
  }): Promise<BuiltModelContext> {
    const { config, sessionStore, memoryStore } = this.deps;
    const { msg, userText } = opts;

    const toolsForModel = opts.toolsForMessage(msg, opts.tools);
    const sessionContext = buildSessionContext(
      sessionStore,
      msg,
      config.engine.session.fetchLimit,
      userText,
    );
    const memorySection = await buildMemorySection({ config, memoryStore, msg, query: userText });
    const maxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const toolGuidance = opts.toolGuidance(toolsForModel);
    const promptSkillsSection = this.deps.promptSkillsSection?.({ msg, query: userText });

    const friendRules = buildFriendBehaviorRules({
      isGroup: msg.isGroup,
      ...(msg.isGroup ? { groupSize: sessionContext.groupSizeEstimate } : {}),
      maxChars,
      ...(opts.behaviorOverride ? { behaviorOverride: opts.behaviorOverride } : {}),
    });

    const system = [
      friendRules,
      '',
      opts.identityPrompt,
      promptSkillsSection ? `\n\n${promptSkillsSection}` : '',
      toolGuidance ? `\n\n${toolGuidance}` : '',
    ].join('\n');

    const dataMessagesForModel = buildDataMessages(sessionContext.systemFromSession, memorySection);

    return {
      toolsForModel,
      historyForModel: sessionContext.historyForModel,
      system,
      dataMessagesForModel,
      maxChars,
    };
  }

  public async buildProactiveModelContext(opts: {
    msg: IncomingMessage;
    event: ProactiveEvent;
    tools: readonly ToolDef[] | undefined;
    toolsForMessage: ToolsForMessage;
    toolGuidance: ToolGuidance;
    identityPrompt: string;
    behaviorOverride?: string | undefined;
  }): Promise<BuiltModelContext> {
    const { config, sessionStore, memoryStore } = this.deps;
    const { msg, event } = opts;

    const toolsForModel = opts.toolsForMessage(msg, opts.tools);
    const sessionContext = buildSessionContext(sessionStore, msg, config.engine.session.fetchLimit);
    const memorySection = await buildMemorySection({
      config,
      memoryStore,
      msg,
      query: event.subject,
    });

    const maxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const toolGuidance = opts.toolGuidance(toolsForModel);
    const promptSkillsSection = this.deps.promptSkillsSection?.({ msg, query: event.subject });
    const friendRules = buildFriendBehaviorRules({
      isGroup: msg.isGroup,
      ...(msg.isGroup ? { groupSize: sessionContext.groupSizeEstimate } : {}),
      maxChars,
      ...(opts.behaviorOverride ? { behaviorOverride: opts.behaviorOverride } : {}),
    });

    const system = [
      friendRules,
      '',
      opts.identityPrompt,
      promptSkillsSection ? `\n\n${promptSkillsSection}` : '',
      toolGuidance ? `\n\n${toolGuidance}` : '',
      '',
      'Write a short, casual friend text to send now.',
      'If it would be weird, forced, or too much, output exactly: HEARTBEAT_OK',
    ].join('\n');

    const dataMessagesForModel = buildDataMessages(sessionContext.systemFromSession, memorySection);

    const proactiveData = [
      '=== PROACTIVE EVENT (DATA) ===',
      `Kind: ${event.kind}`,
      `Subject: ${event.subject}`,
      `TriggerAtMs: ${event.triggerAtMs}`,
    ].join('\n');
    dataMessagesForModel.push({
      role: 'user',
      content: wrapExternal('proactive_event', proactiveData),
    });

    return {
      toolsForModel,
      historyForModel: sessionContext.historyForModel,
      system,
      dataMessagesForModel,
      maxChars,
    };
  }
}
