import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type { HomieConfig } from '../config/types.js';
import { loadIdentityPackage } from '../identity/load.js';
import { formatPersonaReminder } from '../identity/personality.js';
import { composeIdentityPrompt } from '../identity/prompt.js';
import { assembleMemoryContext } from '../memory/context-pack.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProactiveEvent } from '../proactive/types.js';
import type { SessionStore } from '../session/types.js';
import type { ToolDef } from '../tools/types.js';

export type ToolsForMessage = (
  msg: IncomingMessage,
  tools: readonly ToolDef[] | undefined,
) => readonly ToolDef[] | undefined;

export type ToolGuidance = (tools: readonly ToolDef[] | undefined) => string;

export interface IdentityContext {
  readonly identityPrompt: string;
  readonly personaReminder: string;
}

export interface BuiltModelContext {
  readonly toolsForModel: readonly ToolDef[] | undefined;
  readonly historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
  readonly baseSystem: string;
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
} => {
  const sessionMsgs = sessionStore?.getMessages(msg.chatId, fetchLimit) ?? [];

  // In incoming-message turns we persist the user message before the LLM call.
  // Avoid doubling it in the model history if it matches the current userText.
  const maybeLast = sessionMsgs.at(-1);
  const historyMsgs =
    currentUserText && maybeLast?.role === 'user' && maybeLast.content === currentUserText
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

  const sanitizeGroupAuthorLabel = (raw: string): string => {
    const oneLine = raw.replace(/\s+/gu, ' ').trim();
    const noBrackets = oneLine.replaceAll('[', '').replaceAll(']', '').trim();
    return noBrackets.slice(0, 48).trim();
  };

  const renderHistoryContent = (m: (typeof historyMsgs)[number]): string => {
    if (!msg.isGroup) return m.content;
    if (m.role !== 'user') return m.content;

    const label = sanitizeGroupAuthorLabel(m.authorDisplayName ?? m.authorId ?? '');
    if (!label) return m.content;
    return `[${label}] ${m.content}`;
  };

  const historyForModel = historyMsgs
    .filter(isModelHistoryMessage)
    .map((m) => ({ role: m.role, content: renderHistoryContent(m) }));

  return { systemFromSession, historyForModel };
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
  return context.text ? `\n\n${context.text}\n` : '';
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
    return { identityPrompt, personaReminder };
  }

  public async buildReactiveModelContext(opts: {
    msg: IncomingMessage;
    userText: string;
    tools: readonly ToolDef[] | undefined;
    toolsForMessage: ToolsForMessage;
    toolGuidance: ToolGuidance;
    identityPrompt: string;
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
      opts.identityPrompt,
      promptSkillsSection ? `\n\n${promptSkillsSection}` : '',
      sessionContext.systemFromSession
        ? `\n\n=== SESSION NOTES (DATA) ===\n${sessionContext.systemFromSession}`
        : '',
      memorySection,
      toolGuidance ? `\n\n${toolGuidance}` : '',
    ].join('\n');

    return {
      toolsForModel,
      historyForModel: sessionContext.historyForModel,
      baseSystem,
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

    const maxChars = config.behavior.dmMaxChars;
    const toolGuidance = opts.toolGuidance(toolsForModel);
    const promptSkillsSection = this.deps.promptSkillsSection?.({ msg, query: event.subject });
    const baseSystem = [
      '=== FRIEND BEHAVIOR (built-in) ===',
      'You are a friend, not an assistant.',
      'Keep it natural and brief.',
      `Hard limit: reply must be <= ${maxChars} characters.`,
      '',
      opts.identityPrompt,
      promptSkillsSection ? `\n\n${promptSkillsSection}` : '',
      sessionContext.systemFromSession
        ? `\n\n=== SESSION NOTES (DATA) ===\n${sessionContext.systemFromSession}`
        : '',
      memorySection,
      toolGuidance ? `\n\n${toolGuidance}` : '',
      '',
      '=== PROACTIVE EVENT (DATA) ===',
      `Kind: ${event.kind}`,
      `Subject: ${event.subject}`,
      `TriggerAtMs: ${event.triggerAtMs}`,
      '',
      'Write a short friend text to send now.',
      'If it would be weird or too much, output exactly: HEARTBEAT_OK',
    ].join('\n');

    return {
      toolsForModel,
      historyForModel: sessionContext.historyForModel,
      baseSystem,
      maxChars,
    };
  }
}
