import { stat } from 'node:fs/promises';
import path from 'node:path';

import { channelUserId, type IncomingMessage } from '../agent/types.js';
import { buildFriendBehaviorRules } from '../behavior/friendRules.js';
import type { OpenhomieConfig } from '../config/types.js';
import { loadIdentityPackage } from '../identity/load.js';
import { formatPersonaReminder } from '../identity/personality.js';
import { composeIdentityPrompt } from '../identity/prompt.js';
import { assembleMemoryContext } from '../memory/context-pack.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProactiveEvent } from '../proactive/types.js';
import type { OutboundLedger } from '../session/outbound-ledger.js';
import type { SessionStore } from '../session/types.js';
import type { ToolDef } from '../tools/types.js';
import { wrapExternal } from '../tools/util.js';
import { readTextFile } from '../util/fs.js';
import { errorFields, log } from '../util/logger.js';
import { estimateTokens, truncateToTokenBudget } from '../util/tokens.js';
import { renderAgentWalletPrompt } from '../wallet/runtime.js';
import type { AgentRuntimeWallet } from '../wallet/types.js';

const SESSION_NOTES_TOKEN_BUDGET = 400;
const OUTBOUND_LEDGER_TOKEN_BUDGET = 200;
const BOOTSTRAP_DOCS_TOKEN_BUDGET = 900;
const BOOTSTRAP_DOC_MAX_BYTES = 256 * 1024;
const BOOTSTRAP_DOCS_MAX_FILES = 12;
const BOOTSTRAP_DOCS_CACHE_TTL_MS = 30_000;

const logger = log.child({ component: 'context_builder' });

export type ToolsForMessage = (
  msg: IncomingMessage,
  tools: readonly ToolDef[] | undefined,
) => readonly ToolDef[] | undefined;

export type ToolGuidance = (tools: readonly ToolDef[] | undefined) => string;

export interface IdentityContext {
  readonly identityPrompt: string;
  readonly personaReminder: string;
  readonly identityAntiPatterns: readonly string[];
  readonly behaviorOverride?: string | undefined;
}

export interface BuiltModelContext {
  readonly toolsForModel: readonly ToolDef[] | undefined;
  readonly historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
  readonly system: string;
  readonly dataMessagesForModel: Array<{ role: 'user'; content: string }>;
  readonly maxChars: number;
  readonly contextTelemetry?: {
    systemTokens: number;
    identityTokens: number;
    sessionNotesTokens: number;
    memoryTokens: number;
    outboundLedgerTokens: number;
    memorySkipped: boolean;
  };
}

const sanitizeGroupAuthorLabel = (raw: string): string => {
  const capped = raw.slice(0, 256);
  const oneLine = capped.replace(/\s+/gu, ' ').trim();
  const noBrackets = oneLine.replaceAll('[', '').replaceAll(']', '').trim();
  // Keep a conservative charset to avoid injection-y tokens like `SYSTEM:` or role prefixes.
  const safe = noBrackets
    .replace(/[^\p{L}\p{N} ._-]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return safe.slice(0, 48).trim();
};

export const renderGroupUserContent = (opts: {
  readonly authorDisplayName?: string | undefined;
  readonly authorId?: string | undefined;
  readonly content: string;
}): string => {
  const label = sanitizeGroupAuthorLabel(opts.authorDisplayName ?? opts.authorId ?? '');
  if (!label) return opts.content;
  return `[from ${label}] ${opts.content}`;
};

const buildSessionContext = (
  sessionStore: SessionStore | undefined,
  msg: IncomingMessage,
  fetchLimit: number,
  baseMaxChars: number,
  excludeSourceMessageIds?: readonly string[] | undefined,
): {
  systemFromSession: string;
  historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
  groupSizeEstimate: number;
  adaptiveMaxChars?: number | undefined;
} => {
  const rawMsgs = sessionStore?.getMessages(msg.chatId, fetchLimit) ?? [];
  const exclude =
    excludeSourceMessageIds && excludeSourceMessageIds.length > 0
      ? new Set(excludeSourceMessageIds)
      : null;
  const historyMsgs =
    exclude && exclude.size > 0
      ? rawMsgs.filter((m) => !m.sourceMessageId || !exclude.has(m.sourceMessageId))
      : rawMsgs;

  const groupSizeEstimate = msg.isGroup
    ? new Set(
        rawMsgs
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

  const renderHistoryContent = (m: (typeof historyMsgs)[number]): string => {
    if (!msg.isGroup) return m.content;
    if (m.role !== 'user') return m.content;
    return renderGroupUserContent({
      authorDisplayName: m.authorDisplayName,
      authorId: m.authorId,
      content: m.content,
    });
  };

  const historyForModel = historyMsgs
    .filter(isModelHistoryMessage)
    .map((m) => ({ role: m.role, content: renderHistoryContent(m) }));

  // Match the room's typical message length. This is only a cap, not a target.
  // Requires enough samples to avoid snapping to a weird median from sparse history.
  let adaptiveMaxChars: number | undefined;
  const lengths = rawMsgs
    .filter((m) => m.role === 'user')
    .slice(-50)
    .map((m) => m.content.trim().length)
    .filter((n) => n > 0 && n < 10_000);
  if (lengths.length >= 8) {
    lengths.sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
    const minCap = msg.isGroup ? 80 : 120;
    adaptiveMaxChars = Math.min(baseMaxChars, Math.max(minCap, median * 2));
  }

  return { systemFromSession, historyForModel, groupSizeEstimate, adaptiveMaxChars };
};

const buildMemorySection = async (opts: {
  config: OpenhomieConfig;
  memoryStore?: MemoryStore | undefined;
  msg: IncomingMessage;
  query: string;
}): Promise<{ text: string; skipped: boolean; tokensUsed: number }> => {
  const { config, memoryStore, msg, query } = opts;
  if (!memoryStore || !config.memory.enabled) return { text: '', skipped: false, tokensUsed: 0 };

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
  return {
    text: context.text ? context.text : '',
    skipped: context.skipped ?? false,
    tokensUsed: context.tokensUsed,
  };
};

const formatAgeShort = (nowMs: number, atMs: number): string => {
  const ageMs = Math.max(0, nowMs - atMs);
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const buildOutboundLedgerSection = (opts: {
  ledger?: OutboundLedger | undefined;
  msg: IncomingMessage;
}): string => {
  const { ledger, msg } = opts;
  if (!ledger) return '';
  const rows = ledger.listRecent(msg.chatId, 10);
  if (rows.length === 0) return '';

  const nowMs = Date.now();
  const lines: string[] = ['=== OUTBOUND LEDGER (DATA) ==='];
  for (const r of rows) {
    const age = formatAgeShort(nowMs, r.sentAtMs);
    const reply = r.gotReply ? 'yes' : 'no';
    lines.push(`- [${age}] (${r.messageType}, replied: ${reply}) ${r.contentPreview}`);
  }
  return truncateToTokenBudget(lines.join('\n'), OUTBOUND_LEDGER_TOKEN_BUDGET);
};

const buildDataMessages = (
  sessionNotes: string,
  memorySection: string,
  outboundLedgerSection: string,
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
  if (outboundLedgerSection) {
    out.push({
      role: 'user',
      content: wrapExternal('outbound_ledger', outboundLedgerSection),
    });
  }
  return out;
};

export class ContextBuilder {
  private readonly bootstrapDocsCache = new Map<string, { text: string; readAtMs: number }>();

  public constructor(
    private readonly deps: {
      config: OpenhomieConfig;
      sessionStore?: SessionStore | undefined;
      memoryStore?: MemoryStore | undefined;
      outboundLedger?: OutboundLedger | undefined;
      promptSkillsSection?: ((opts: { msg: IncomingMessage; query: string }) => string) | undefined;
      hasChannelsConfigured?: boolean | undefined;
      agentRuntimeWallet?: AgentRuntimeWallet | undefined;
    },
  ) {}

  private async readBootstrapDocText(absPath: string): Promise<string | null> {
    const nowMs = Date.now();
    const cached = this.bootstrapDocsCache.get(absPath);
    if (cached && nowMs - cached.readAtMs <= BOOTSTRAP_DOCS_CACHE_TTL_MS) return cached.text;

    try {
      const s = await stat(absPath);
      if (s.size > BOOTSTRAP_DOC_MAX_BYTES) {
        logger.debug('bootstrap_docs.too_large', { path: absPath, sizeBytes: s.size });
        return null;
      }
      const text = await readTextFile(absPath);
      this.bootstrapDocsCache.set(absPath, { text, readAtMs: nowMs });
      return text;
    } catch (err) {
      logger.debug('bootstrap_docs.read_failed', { path: absPath, ...errorFields(err) });
      return null;
    }
  }

  private async buildBootstrapDocsSection(): Promise<string> {
    const relPaths = this.deps.config.paths.bootstrapDocs;
    if (!relPaths || relPaths.length === 0) return '';

    const projectDir = path.resolve(this.deps.config.paths.projectDir);
    const seen = new Set<string>();
    const requested = relPaths
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .slice(0, BOOTSTRAP_DOCS_MAX_FILES);

    let remainingTokens = BOOTSTRAP_DOCS_TOKEN_BUDGET;
    const docs: string[] = [];

    for (const rel of requested) {
      if (remainingTokens <= 0) break;
      if (path.isAbsolute(rel)) {
        logger.debug('bootstrap_docs.invalid_path', { rel });
        continue;
      }

      const abs = path.resolve(projectDir, rel);
      if (abs !== projectDir && !abs.startsWith(`${projectDir}${path.sep}`)) {
        logger.debug('bootstrap_docs.outside_project_dir', { rel });
        continue;
      }

      const raw = await this.readBootstrapDocText(abs);
      const trimmed = raw?.trim();
      if (!trimmed) continue;

      // Ensure we never bloat the prompt: cap total + per-doc contribution.
      const perDocBudget = Math.min(remainingTokens, Math.floor(BOOTSTRAP_DOCS_TOKEN_BUDGET * 0.8));
      const capped = truncateToTokenBudget(trimmed, perDocBudget);
      const wrapped = wrapExternal(`bootstrap_doc:${rel}`, capped);
      const used = estimateTokens(wrapped);
      if (used > remainingTokens) break;

      docs.push(wrapped);
      remainingTokens = Math.max(0, remainingTokens - used);
    }

    if (docs.length === 0) return '';
    return ['=== BOOTSTRAP DOCS (DATA) ===', ...docs].join('\n\n');
  }

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
      identityAntiPatterns: identity.personality.antiPatterns,
      ...(identity.behavior ? { behaviorOverride: identity.behavior } : {}),
    };
  }

  public async buildReactiveModelContext(opts: {
    msg: IncomingMessage;
    excludeSourceMessageIds?: readonly string[] | undefined;
    query?: string | undefined;
    tools: readonly ToolDef[] | undefined;
    toolsForMessage: ToolsForMessage;
    toolGuidance: ToolGuidance;
    identityPrompt: string;
    behaviorOverride?: string | undefined;
  }): Promise<BuiltModelContext> {
    const { config, sessionStore, memoryStore } = this.deps;
    const { msg } = opts;
    const query = opts.query ?? msg.text;

    const toolsForModel = opts.toolsForMessage(msg, opts.tools);
    const baseMaxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const sessionContext = buildSessionContext(
      sessionStore,
      msg,
      config.engine.session.fetchLimit,
      baseMaxChars,
      opts.excludeSourceMessageIds,
    );
    const memorySection = await buildMemorySection({ config, memoryStore, msg, query });
    const outboundLedgerSection = buildOutboundLedgerSection({
      ledger: this.deps.outboundLedger,
      msg,
    });
    const maxChars = sessionContext.adaptiveMaxChars ?? baseMaxChars;
    const toolGuidance = opts.toolGuidance(toolsForModel);
    const promptSkillsSection = this.deps.promptSkillsSection?.({ msg, query });
    const bootstrapDocsSection = await this.buildBootstrapDocsSection();

    const friendRules = buildFriendBehaviorRules({
      isGroup: msg.isGroup,
      ...(msg.isGroup ? { groupSize: sessionContext.groupSizeEstimate } : {}),
      maxChars,
      overrideBuiltinRules: config.behavior.overrideBuiltinRules,
      ...(opts.behaviorOverride ? { behaviorOverride: opts.behaviorOverride } : {}),
    });

    const channelNudge =
      msg.channel === 'cli' && !this.deps.hasChannelsConfigured
        ? '\n\nThe user is chatting via the developer CLI. If the conversation feels natural, casually suggest they connect Telegram or Signal so you can chat on their phone — but only once, and only if it fits the flow.'
        : '';

    const systemParts = [friendRules, ''];
    if (bootstrapDocsSection) systemParts.push(bootstrapDocsSection, '');
    systemParts.push(
      opts.identityPrompt,
      this.deps.agentRuntimeWallet
        ? `\n\n${renderAgentWalletPrompt(this.deps.agentRuntimeWallet)}`
        : '',
      promptSkillsSection ? `\n\n${promptSkillsSection}` : '',
      toolGuidance ? `\n\n${toolGuidance}` : '',
      channelNudge,
    );
    const system = systemParts.join('\n');

    const dataMessagesForModel = buildDataMessages(
      sessionContext.systemFromSession,
      memorySection.text,
      outboundLedgerSection,
    );

    const contextTelemetry = {
      systemTokens: estimateTokens(system),
      identityTokens: estimateTokens(opts.identityPrompt),
      sessionNotesTokens: sessionContext.systemFromSession
        ? estimateTokens(
            truncateToTokenBudget(sessionContext.systemFromSession, SESSION_NOTES_TOKEN_BUDGET),
          )
        : 0,
      memoryTokens: memorySection.text ? estimateTokens(memorySection.text) : 0,
      outboundLedgerTokens: outboundLedgerSection ? estimateTokens(outboundLedgerSection) : 0,
      memorySkipped: memorySection.skipped,
    };

    return {
      toolsForModel,
      historyForModel: sessionContext.historyForModel,
      system,
      dataMessagesForModel,
      maxChars,
      contextTelemetry,
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
    const baseMaxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const sessionContext = buildSessionContext(
      sessionStore,
      msg,
      config.engine.session.fetchLimit,
      baseMaxChars,
    );
    const memorySection = await buildMemorySection({
      config,
      memoryStore,
      msg,
      query: event.subject,
    });
    const outboundLedgerSection = buildOutboundLedgerSection({
      ledger: this.deps.outboundLedger,
      msg,
    });

    const maxChars = sessionContext.adaptiveMaxChars ?? baseMaxChars;
    const toolGuidance = opts.toolGuidance(toolsForModel);
    const promptSkillsSection = this.deps.promptSkillsSection?.({ msg, query: event.subject });
    const bootstrapDocsSection = await this.buildBootstrapDocsSection();
    const friendRules = buildFriendBehaviorRules({
      isGroup: msg.isGroup,
      ...(msg.isGroup ? { groupSize: sessionContext.groupSizeEstimate } : {}),
      maxChars,
      overrideBuiltinRules: config.behavior.overrideBuiltinRules,
      ...(opts.behaviorOverride ? { behaviorOverride: opts.behaviorOverride } : {}),
    });

    const systemParts = [friendRules, ''];
    if (bootstrapDocsSection) systemParts.push(bootstrapDocsSection, '');
    systemParts.push(
      opts.identityPrompt,
      this.deps.agentRuntimeWallet
        ? `\n\n${renderAgentWalletPrompt(this.deps.agentRuntimeWallet)}`
        : '',
      promptSkillsSection ? `\n\n${promptSkillsSection}` : '',
      toolGuidance ? `\n\n${toolGuidance}` : '',
      '',
      'Write a short, casual friend text to send now.',
      'If it would be weird, forced, or too much, output exactly: HEARTBEAT_OK',
      '',
      'VERIFY before writing:',
      '- Is the topic still relevant? If resolved, HEARTBEAT_OK.',
      '- Would a real friend send this right now? If unsure, HEARTBEAT_OK.',
      '- Never reference other chats, logs, or "memory" (act like a normal friend).',
      '',
      'STYLE FAILURES (do NOT do these):',
      '- "Hey! Just wanted to check in about..." (too formal, exclamation)',
      '- "I hope you don\'t mind me asking, but..." (hedging)',
      '- "Let me know if you need anything!" (assistant energy)',
      '- "So, I was thinking about what you said..." (filler opening)',
      '- "Hope you\'re doing well! Quick question..." (forced pleasantry)',
      '- "just wanted to check in"',
      '- "quick question:"',
      '',
      'GOOD examples:',
      '- "did that interview thing ever work out"',
      '- "how\'s the new place btw"',
      '- "lol did you end up going"',
    );
    const system = systemParts.join('\n');

    const dataMessagesForModel = buildDataMessages(
      sessionContext.systemFromSession,
      memorySection.text,
      outboundLedgerSection,
    );

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

    const contextTelemetry = {
      systemTokens: estimateTokens(system),
      identityTokens: estimateTokens(opts.identityPrompt),
      sessionNotesTokens: sessionContext.systemFromSession
        ? estimateTokens(
            truncateToTokenBudget(sessionContext.systemFromSession, SESSION_NOTES_TOKEN_BUDGET),
          )
        : 0,
      memoryTokens: memorySection.text ? estimateTokens(memorySection.text) : 0,
      outboundLedgerTokens: outboundLedgerSection ? estimateTokens(outboundLedgerSection) : 0,
      memorySkipped: memorySection.skipped,
    };

    return {
      toolsForModel,
      historyForModel: sessionContext.historyForModel,
      system,
      dataMessagesForModel,
      maxChars,
      contextTelemetry,
    };
  }
}
