import path from 'node:path';

import { createBackend } from '../backend/factory.js';
import { createInstrumentedBackend } from '../backend/instrumented.js';
import type { LLMBackend } from '../backend/types.js';
import { parseChatId } from '../channels/chatId.js';
import { runCliChat } from '../channels/cli.js';
import { runSignalAdapter } from '../channels/signal.js';
import { sendSignalDaemonTextFromEnv } from '../channels/signal-daemon.js';
import { runTelegramAdapter } from '../channels/telegram.js';
import { loadOpenhomieConfig } from '../config/load.js';
import type { OpenhomieConfig } from '../config/types.js';
import { TurnEngine } from '../engine/turnEngine.js';
import type { OutgoingAction } from '../engine/types.js';
import { SqliteFeedbackStore } from '../feedback/sqlite.js';
import { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { createBehaviorInsightsHook } from '../hooks/behaviorInsights.js';
import { createEpisodeLoggerHook } from '../hooks/episodeLogger.js';
import { createGroupTrackerHook } from '../hooks/groupTracker.js';
import { HookRegistry } from '../hooks/registry.js';
import { createSlopTelemetryHook } from '../hooks/slopTelemetry.js';
import { MemoryConsolidationLoop, runMemoryConsolidationOnce } from '../memory/consolidation.js';
import { createMemoryExtractor, type MemoryExtractor } from '../memory/extractor.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { CheckInPlanner } from '../proactive/checkinPlanner.js';
import { GroupCheckInPlanner } from '../proactive/groupCheckinPlanner.js';
import { HeartbeatLoop } from '../proactive/heartbeat.js';
import { EventScheduler } from '../proactive/scheduler.js';
import type { ProactiveEvent } from '../proactive/types.js';
import { indexPromptSkillsFromDirectory } from '../prompt-skills/loader.js';
import { SqliteOutboundLedger } from '../session/outbound-ledger.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { SqliteTelemetryStore } from '../telemetry/sqlite.js';
import { createToolRegistry, getToolsForTier } from '../tools/registry.js';
import type { ToolMediaAttachment, ToolTier } from '../tools/types.js';
import { asChatId } from '../types/ids.js';
import { startHealthServer } from '../util/health.js';
import { Lifecycle } from '../util/lifecycle.js';
import { errorFields, log } from '../util/logger.js';
import { assertWalletFeatureCompatibility, loadWalletFeatureFlags } from '../wallet/flags.js';
import { loadAgentRuntimeWallet } from '../wallet/runtime.js';
import type { AgentRuntimeWallet } from '../wallet/types.js';

export interface HarnessBoot {
  readonly configPath: string;
  readonly config: OpenhomieConfig;
  readonly backend: LLMBackend;
  readonly llm: ReturnType<typeof createInstrumentedBackend>;
  readonly engine: TurnEngine;
  readonly hooks: HookRegistry;
  readonly extractor: MemoryExtractor;

  readonly lifecycle: Lifecycle;
  readonly sessionStore: SqliteSessionStore;
  readonly outboundLedger: SqliteOutboundLedger;
  readonly scheduler?: EventScheduler | undefined;
  readonly memoryStore: SqliteMemoryStore;
  readonly telemetryStore: SqliteTelemetryStore;
  readonly feedbackTracker: FeedbackTracker;
  readonly consolidationLoop: MemoryConsolidationLoop;
  readonly agentWallet: AgentRuntimeWallet | undefined;
}

interface HarnessEnv extends NodeJS.ProcessEnv {
  SIGNAL_API_URL?: string;
  SIGNAL_NUMBER?: string;
  SIGNAL_DAEMON_URL?: string;
  SIGNAL_HTTP_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

class Harness {
  private readonly logger = log.child({ component: 'harness' });
  private heartbeat: HeartbeatLoop | undefined;
  private checkins: CheckInPlanner | undefined;
  private groupCheckins: GroupCheckInPlanner | undefined;
  private health:
    | {
        stop(): void;
      }
    | undefined;

  private constructor(
    private readonly boot: HarnessBoot,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  public static async bootFromEnv(opts?: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  }): Promise<Harness> {
    const cwd = opts?.cwd ?? process.cwd();
    const env = opts?.env ?? process.env;
    const loaded = await loadOpenhomieConfig({ cwd, env });
    const walletFlags = loadWalletFeatureFlags(env);
    assertWalletFeatureCompatibility(walletFlags);
    const lifecycle = new Lifecycle();
    const agentWallet = walletFlags.identityEnabled ? await loadAgentRuntimeWallet(env) : undefined;

    const toolReg = await createToolRegistry({
      identityDir: loaded.config.paths.identityDir,
      skillsDir: loaded.config.paths.skillsDir,
    });
    const allowedTiers: ToolTier[] = ['safe'];
    if (loaded.config.tools.restricted.enabledForOperator) allowedTiers.push('restricted');
    if (loaded.config.tools.dangerous.enabledForOperator) allowedTiers.push('dangerous');
    const tools = getToolsForTier(toolReg, allowedTiers);

    const promptSkillsDir = path.join(loaded.config.paths.skillsDir, 'prompt');
    const promptSkills = indexPromptSkillsFromDirectory(promptSkillsDir, {
      allowedBaseDir: loaded.config.paths.skillsDir,
    });

    const { backend, embedder } = await createBackend({ config: loaded.config, env });
    const sessionStore = new SqliteSessionStore({
      dbPath: `${loaded.config.paths.dataDir}/sessions.db`,
    });
    const outboundLedger = new SqliteOutboundLedger({
      dbPath: `${loaded.config.paths.dataDir}/sessions.db`,
    });
    const scheduler = loaded.config.proactive.enabled
      ? new EventScheduler({ dbPath: `${loaded.config.paths.dataDir}/proactive.db` })
      : undefined;
    const memoryStore = new SqliteMemoryStore({
      dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      ...(embedder ? { embedder } : {}),
      retrieval: {
        rrfK: loaded.config.memory.retrieval.rrfK,
        ftsWeight: loaded.config.memory.retrieval.ftsWeight,
        vecWeight: loaded.config.memory.retrieval.vecWeight,
        recencyWeight: loaded.config.memory.decay.enabled
          ? loaded.config.memory.retrieval.recencyWeight
          : 0,
        halfLifeDays: loaded.config.memory.decay.halfLifeDays,
      },
    });
    const telemetryStore = new SqliteTelemetryStore({
      dbPath: `${loaded.config.paths.dataDir}/telemetry.db`,
    });
    const llm = createInstrumentedBackend({
      backend,
      telemetry: telemetryStore,
      defaultCaller: 'runtime',
    });
    const feedbackStore = new SqliteFeedbackStore({
      dbPath: `${loaded.config.paths.dataDir}/feedback.db`,
    });
    const feedbackTracker = new FeedbackTracker({
      store: feedbackStore,
      backend: llm,
      memory: memoryStore,
      config: loaded.config,
      signal: lifecycle.signal,
    });
    const extractor = createMemoryExtractor({
      backend: llm,
      store: memoryStore,
      ...(embedder ? { embedder } : {}),
      ...(scheduler ? { scheduler } : {}),
      timezone: loaded.config.behavior.sleep.timezone,
      signal: lifecycle.signal,
    });
    const hookRegistry = new HookRegistry(log.child({ component: 'hooks' }));
    hookRegistry.register({
      onTurnComplete: async () => {
        lifecycle.markSuccessfulTurn();
      },
    });
    hookRegistry.register(
      createGroupTrackerHook({
        memoryStore,
        logger: log.child({ component: 'hook_group_tracker' }),
      }),
    );
    hookRegistry.register(
      createSlopTelemetryHook({
        telemetry: telemetryStore,
        logger: log.child({ component: 'hook_slop_telemetry' }),
      }),
    );
    hookRegistry.register(
      createEpisodeLoggerHook({
        memoryStore,
        logger: log.child({ component: 'hook_episode_logger' }),
      }),
    );
    hookRegistry.register(
      createBehaviorInsightsHook({
        config: loaded.config,
        memoryStore,
        sessionStore,
        logger: log.child({ component: 'hook_behavior_insights' }),
      }),
    );
    await hookRegistry.emit('onBootstrap', { config: loaded.config });
    const consolidationLoop = new MemoryConsolidationLoop({
      backend: llm,
      store: memoryStore,
      config: loaded.config,
      extractor,
      signal: lifecycle.signal,
    });
    const runtimeEnv = env as HarnessEnv;
    const hasChannelsConfigured = Boolean(
      runtimeEnv.TELEGRAM_BOT_TOKEN?.trim() ||
        runtimeEnv.SIGNAL_DAEMON_URL?.trim() ||
        runtimeEnv.SIGNAL_HTTP_URL?.trim() ||
        runtimeEnv.SIGNAL_API_URL?.trim(),
    );
    const engine = new TurnEngine({
      config: loaded.config,
      backend: llm,
      tools,
      promptSkills,
      sessionStore,
      memoryStore,
      extractor,
      outboundLedger,
      ...(scheduler ? { eventScheduler: scheduler } : {}),
      signal: lifecycle.signal,
      trackBackground: lifecycle.track.bind(lifecycle),
      hooks: hookRegistry,
      telemetry: telemetryStore,
      hasChannelsConfigured,
      agentRuntimeWallet: agentWallet,
    });

    const h = new Harness(
      {
        configPath: loaded.configPath,
        config: loaded.config,
        backend,
        llm,
        engine,
        extractor,
        hooks: hookRegistry,
        lifecycle,
        sessionStore,
        outboundLedger,
        scheduler,
        memoryStore,
        telemetryStore,
        feedbackTracker,
        consolidationLoop,
        agentWallet,
      },
      env,
    );
    return h;
  }

  public async runChat(): Promise<void> {
    try {
      await runCliChat({
        config: this.boot.config,
        engine: this.boot.engine,
        agentWallet: this.boot.agentWallet,
      });
    } finally {
      await this.close({ reason: 'chat_end' });
    }
  }

  public async runConsolidationOnce(): Promise<void> {
    this.boot.consolidationLoop.stop();
    this.boot.feedbackTracker.stop();
    await runMemoryConsolidationOnce({
      backend: this.boot.llm,
      store: this.boot.memoryStore,
      config: this.boot.config,
      extractor: this.boot.extractor,
      signal: this.boot.lifecycle.signal,
    });
    await this.close({ reason: 'consolidation_complete' });
  }

  private async probeMppBalance(cfg: OpenhomieConfig): Promise<void> {
    const provider = cfg.model.provider;
    const baseUrl = (provider.kind === 'mpp' ? provider.baseUrl : 'https://mpp.tempo.xyz').replace(
      /\/+$/u,
      '',
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      await this.boot.llm.complete({
        role: 'fast',
        messages: [
          { role: 'system', content: 'Return exactly: ok' },
          { role: 'user', content: 'preflight' },
        ],
        maxSteps: 1,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const low = msg.toLowerCase();
      if (low.includes('insufficient') || low.includes('402') || low.includes('balance')) {
        process.stderr.write(
          `[homie] MPP wallet may not be funded. Fund your wallet and check with \`homie doctor --verify-mpp\`.\n` +
            `[homie] Endpoint: ${baseUrl}\n`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  public async startRuntime(): Promise<void> {
    const cfg = this.boot.config;
    const channels: Promise<void>[] = [];

    const env = this.env as HarnessEnv;

    if (env.SIGNAL_API_URL || env.SIGNAL_DAEMON_URL || env.SIGNAL_HTTP_URL) {
      channels.push(
        runSignalAdapter({
          config: cfg,
          engine: this.boot.engine,
          feedback: this.boot.feedbackTracker,
          signal: this.boot.lifecycle.signal,
        }),
      );
    }
    if (env.TELEGRAM_BOT_TOKEN) {
      channels.push(
        runTelegramAdapter({
          config: cfg,
          engine: this.boot.engine,
          feedback: this.boot.feedbackTracker,
          signal: this.boot.lifecycle.signal,
        }),
      );
    }

    if (channels.length === 0) {
      throw new Error(
        'No channels configured. Set TELEGRAM_BOT_TOKEN or SIGNAL_DAEMON_URL, then run `homie start`.',
      );
    }

    if (cfg.model.provider.kind === 'mpp') {
      this.probeMppBalance(cfg).catch((err) => {
        this.logger.debug('mpp.preflight.failed', errorFields(err));
      });
    }

    if (cfg.proactive.enabled && this.boot.scheduler) {
      this.heartbeat = new HeartbeatLoop({
        scheduler: this.boot.scheduler,
        proactiveConfig: cfg.proactive,
        behaviorConfig: cfg.behavior,
        memoryStore: this.boot.memoryStore,
        outboundLedger: this.boot.outboundLedger,
        getLastUserMessageMs: (id) => this.getLastUserMessageMs(String(id)),
        onProactive: async (event) => {
          const out = await this.boot.engine.handleProactiveEvent(event);
          if (out.kind !== 'send_text') return false;
          if (!out.text.trim() && !(out.media?.length ?? 0)) return false;
          await this.sendProactiveText(event, out);
          return true;
        },
        signal: this.boot.lifecycle.signal,
      });
      this.heartbeat.start();

      this.checkins = new CheckInPlanner({
        scheduler: this.boot.scheduler,
        proactiveConfig: cfg.proactive,
        behaviorConfig: cfg.behavior,
        memoryStore: this.boot.memoryStore,
        getLastUserMessageMs: (id) => this.getLastUserMessageMs(String(id)),
        signal: this.boot.lifecycle.signal,
      });
      this.checkins.start();

      this.groupCheckins = new GroupCheckInPlanner({
        scheduler: this.boot.scheduler,
        proactiveConfig: cfg.proactive,
        behaviorConfig: cfg.behavior,
        memoryStore: this.boot.memoryStore,
        sessionStore: this.boot.sessionStore,
        getLastUserMessageMs: (id) => this.getLastUserMessageMs(String(id)),
        signal: this.boot.lifecycle.signal,
      });
      this.groupCheckins.start();
    }

    this.boot.feedbackTracker.start();
    this.boot.consolidationLoop.start();

    this.health = startHealthServer({
      lifecycle: this.boot.lifecycle,
      checks: [
        () => this.boot.sessionStore.ping(),
        () => this.boot.memoryStore.ping(),
        () => this.boot.telemetryStore.ping(),
        () => this.boot.scheduler?.ping(),
        () => this.boot.feedbackTracker.healthCheck(),
        () => this.boot.consolidationLoop.healthCheck(),
        () => this.heartbeat?.healthCheck(),
      ].filter((c): c is () => void => typeof c === 'function'),
    });

    const shutdown = (reason: string): void => {
      const forceExit = setTimeout(() => process.exit(1), 10_000);
      forceExit.unref();
      void this.close({ reason })
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.stdout.write(`homie: starting ${channels.length} channel(s)\n`);
    await Promise.all(channels);
  }

  public async close(opts: { reason: string }): Promise<void> {
    for (const chatId of this.boot.engine.getKnownChatIds()) {
      try {
        await this.boot.hooks.emit('onSessionEnd', { chatId });
      } catch (_err) {
        // Best-effort: shutdown should not fail due to hooks.
      }
    }
    await this.boot.lifecycle.shutdown({
      reason: opts.reason,
      stop: [
        { stop: () => this.heartbeat?.stop() },
        { stop: () => this.checkins?.stop() },
        { stop: () => this.groupCheckins?.stop() },
        { stop: () => this.boot.feedbackTracker.stop() },
        { stop: () => this.boot.consolidationLoop.stop() },
        { stop: () => this.health?.stop() },
      ],
      drain: [() => this.boot.engine.drain()],
      close: [
        () => this.boot.sessionStore.close(),
        () => this.boot.outboundLedger.close(),
        () => this.boot.memoryStore.close(),
        () => this.boot.telemetryStore.close(),
        () => this.boot.feedbackTracker.close(),
        ...(this.boot.scheduler
          ? [
              () => {
                this.boot.scheduler?.close();
              },
            ]
          : []),
      ],
    });
  }

  private getLastUserMessageMs(chatId: string): number | undefined {
    const msgs = this.boot.sessionStore.getMessages(asChatId(chatId), 50);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === 'user') return m.createdAtMs;
    }
    return undefined;
  }

  private async sendTelegramProactiveAttachment(opts: {
    token: string;
    chatId: number;
    attachment: ToolMediaAttachment;
    caption?: string | undefined;
  }): Promise<number | undefined> {
    const maxBytes = 12 * 1024 * 1024;
    if (opts.attachment.bytes.byteLength <= 0 || opts.attachment.bytes.byteLength > maxBytes)
      return undefined;

    const endpoint =
      opts.attachment.kind === 'image'
        ? 'sendPhoto'
        : opts.attachment.kind === 'animation'
          ? 'sendAnimation'
          : opts.attachment.kind === 'audio'
            ? opts.attachment.asVoiceNote
              ? 'sendVoice'
              : 'sendAudio'
            : 'sendDocument';
    const field =
      endpoint === 'sendPhoto'
        ? 'photo'
        : endpoint === 'sendAnimation'
          ? 'animation'
          : endpoint === 'sendVoice'
            ? 'voice'
            : endpoint === 'sendAudio'
              ? 'audio'
              : 'document';

    const fd = new FormData();
    fd.append('chat_id', String(opts.chatId));
    const caption = opts.caption?.trim();
    if (caption) fd.append('caption', caption.slice(0, 900));
    const mime = opts.attachment.mime || 'application/octet-stream';
    const fileName = opts.attachment.fileName ?? 'attachment';
    const bytes = Uint8Array.from(opts.attachment.bytes);
    fd.append(field, new Blob([bytes], { type: mime }), fileName);

    const res = await fetch(`https://api.telegram.org/bot${opts.token}/${endpoint}`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`telegram proactive send failed: HTTP ${res.status} ${detail}`);
    }
    try {
      const json = (await res.json()) as { result?: { message_id?: number } } | undefined;
      const messageId = json?.result?.message_id;
      return typeof messageId === 'number' ? messageId : undefined;
    } catch (_err) {
      return undefined;
    }
  }

  private async sendProactiveText(
    event: ProactiveEvent,
    out: Extract<OutgoingAction, { kind: 'send_text' }>,
  ): Promise<void> {
    const trimmed = out.text.trim();
    const media = out.media ?? [];
    if (!trimmed && media.length === 0) return;
    const chatId = String(event.chatId);
    const parsed = parseChatId(chatId);
    if (!parsed) return;

    if (parsed.channel === 'cli') {
      if (trimmed) process.stdout.write(`[proactive] ${trimmed}\n`);
      if (media.length) process.stdout.write(`[proactive] attachments: ${media.length}\n`);
      try {
        const brandedChatId = asChatId(chatId);
        const refId = `proactive:${event.id}:${Date.now()}`;
        this.boot.feedbackTracker.onOutgoingSent({
          channel: 'cli',
          chatId: brandedChatId,
          refKey: makeOutgoingRefKey(brandedChatId, { channel: 'cli', id: refId }),
          isGroup: false,
          sentAtMs: Date.now(),
          text: trimmed || '[attachments]',
          messageType: 'proactive',
          proactiveEventId: String(event.id),
          proactiveKind: event.kind,
          proactiveSubject: event.subject,
          primaryChannelUserId: 'cli:operator',
        });
      } catch (_err) {
        // Best-effort: CLI proactive tracking is optional.
      }
      return;
    }

    const env = this.env as HarnessEnv;

    if (parsed.channel === 'telegram') {
      const token = env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) return;
      const brandedChatId = asChatId(chatId);
      let messageId: number | undefined;
      if (trimmed) {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(parsed.id), text: trimmed }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`telegram proactive send failed: HTTP ${res.status} ${detail}`);
        }
        try {
          const json = (await res.json()) as { result?: { message_id?: number } } | undefined;
          const mid = json?.result?.message_id;
          if (typeof mid === 'number') messageId = mid;
        } catch (_err) {
          messageId = undefined;
        }
      }

      let isFirstAttachment = true;
      for (const m of media) {
        const caption =
          !trimmed && isFirstAttachment
            ? String(m.altText ?? '')
                .trim()
                .slice(0, 900)
            : undefined;
        const mid = await this.sendTelegramProactiveAttachment({
          token,
          chatId: Number(parsed.id),
          attachment: m,
          caption,
        });
        messageId ??= mid;
        isFirstAttachment = false;
      }

      try {
        if (typeof messageId === 'number') {
          this.boot.feedbackTracker.onOutgoingSent({
            channel: 'telegram',
            chatId: brandedChatId,
            refKey: makeOutgoingRefKey(brandedChatId, { channel: 'telegram', messageId }),
            isGroup: parsed.kind === 'group',
            sentAtMs: Date.now(),
            text: trimmed || '[attachments]',
            messageType: 'proactive',
            proactiveEventId: String(event.id),
            proactiveKind: event.kind,
            proactiveSubject: event.subject,
            primaryChannelUserId: parsed.kind === 'dm' ? `telegram:${parsed.id}` : undefined,
          });
        }
      } catch (_err) {
        // Best-effort: response shape can differ; feedback is optional.
      }
      return;
    }

    if (parsed.channel === 'signal') {
      const apiUrl = env.SIGNAL_API_URL?.trim();
      const number = env.SIGNAL_NUMBER?.trim();
      const canSendAttachments = Boolean(apiUrl && number && media.length);
      if (!trimmed && !canSendAttachments) return;

      if (!canSendAttachments && (env.SIGNAL_DAEMON_URL || env.SIGNAL_HTTP_URL)) {
        const tsSent = (await sendSignalDaemonTextFromEnv(env, chatId, trimmed)) ?? Date.now();
        const number = env.SIGNAL_NUMBER?.trim();
        if (number) {
          const brandedChatId = asChatId(chatId);
          this.boot.feedbackTracker.onOutgoingSent({
            channel: 'signal',
            chatId: brandedChatId,
            refKey: makeOutgoingRefKey(brandedChatId, {
              channel: 'signal',
              targetAuthor: number,
              targetTimestampMs: tsSent,
            }),
            isGroup: parsed.kind === 'group',
            sentAtMs: tsSent,
            text: trimmed || '[attachments]',
            messageType: 'proactive',
            proactiveEventId: String(event.id),
            proactiveKind: event.kind,
            proactiveSubject: event.subject,
            primaryChannelUserId: parsed.kind === 'dm' ? `signal:${parsed.id}` : undefined,
          });
        }
        return;
      }

      if (!apiUrl || !number) return;
      const brandedChatId = asChatId(chatId);
      const maxBytes = 12 * 1024 * 1024;
      const base64_attachments = media
        .filter((m) => m.bytes.byteLength > 0 && m.bytes.byteLength <= maxBytes)
        .slice(0, 4)
        .map((m) => ({
          filename: m.fileName ?? 'attachment',
          contentType: m.mime || 'application/octet-stream',
          base64: Buffer.from(m.bytes).toString('base64'),
        }));
      const body = {
        message:
          trimmed || (media[0]?.altText ? String(media[0].altText).trim().slice(0, 900) : ''),
        number,
        recipients: [parsed.id],
        ...(base64_attachments.length ? { base64_attachments } : {}),
      };
      const res = await fetch(`${apiUrl.replace(/\/+$/u, '')}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`signal proactive send failed: HTTP ${res.status} ${detail}`);
      }
      try {
        const json = (await res.json()) as { timestamp?: number } | undefined;
        const tsSent = typeof json?.timestamp === 'number' ? json.timestamp : Date.now();
        this.boot.feedbackTracker.onOutgoingSent({
          channel: 'signal',
          chatId: brandedChatId,
          refKey: makeOutgoingRefKey(brandedChatId, {
            channel: 'signal',
            targetAuthor: number,
            targetTimestampMs: tsSent,
          }),
          isGroup: parsed.kind === 'group',
          sentAtMs: tsSent,
          text: trimmed || '[attachments]',
          messageType: 'proactive',
          proactiveEventId: String(event.id),
          proactiveKind: event.kind,
          proactiveSubject: event.subject,
          primaryChannelUserId: parsed.kind === 'dm' ? `signal:${parsed.id}` : undefined,
        });
      } catch (_err) {
        // Best-effort: response shape can differ; feedback is optional.
      }
    }
  }
}

export const runMain = async (cmd: string, _args: readonly string[]): Promise<void> => {
  try {
    switch (cmd) {
      case 'chat': {
        const h = await Harness.bootFromEnv();
        await h.runChat();
        return;
      }
      case 'start': {
        const h = await Harness.bootFromEnv();
        await h.startRuntime();
        return;
      }
      case 'consolidate': {
        const h = await Harness.bootFromEnv();
        await h.runConsolidationOnce();
        process.stdout.write('homie: consolidation complete\n');
        return;
      }
      default:
        // Commands that need bespoke args are handled by cli.ts.
        return;
    }
  } catch (err) {
    const logger = log.child({ component: 'harness' });
    logger.error('runMain.error', errorFields(err));
    throw err;
  }
};
