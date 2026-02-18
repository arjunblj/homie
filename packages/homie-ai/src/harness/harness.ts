import path from 'node:path';

import { AiSdkBackend } from '../backend/ai-sdk.js';
import { createInstrumentedBackend } from '../backend/instrumented.js';
import { parseChatId } from '../channels/chatId.js';
import { runCliChat } from '../channels/cli.js';
import { runSignalAdapter } from '../channels/signal.js';
import { sendSignalDaemonTextFromEnv } from '../channels/signal-daemon.js';
import { runTelegramAdapter } from '../channels/telegram.js';
import { loadHomieConfig } from '../config/load.js';
import type { HomieConfig } from '../config/types.js';
import { TurnEngine } from '../engine/turnEngine.js';
import { SqliteFeedbackStore } from '../feedback/sqlite.js';
import { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { MemoryConsolidationLoop, runMemoryConsolidationOnce } from '../memory/consolidation.js';
import { createMemoryExtractor } from '../memory/extractor.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { HeartbeatLoop } from '../proactive/heartbeat.js';
import { EventScheduler } from '../proactive/scheduler.js';
import { indexPromptSkillsFromDirectory } from '../prompt-skills/loader.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { SqliteTelemetryStore } from '../telemetry/sqlite.js';
import { createToolRegistry, getToolsForTier } from '../tools/registry.js';
import type { ToolTier } from '../tools/types.js';
import { asChatId } from '../types/ids.js';
import { startHealthServer } from '../util/health.js';
import { Lifecycle } from '../util/lifecycle.js';
import { errorFields, log } from '../util/logger.js';

export interface HarnessBoot {
  readonly configPath: string;
  readonly config: HomieConfig;
  readonly backend: AiSdkBackend;
  readonly llm: ReturnType<typeof createInstrumentedBackend>;
  readonly engine: TurnEngine;

  readonly lifecycle: Lifecycle;
  readonly sessionStore: SqliteSessionStore;
  readonly scheduler?: EventScheduler | undefined;
  readonly memoryStore: SqliteMemoryStore;
  readonly telemetryStore: SqliteTelemetryStore;
  readonly feedbackTracker: FeedbackTracker;
  readonly consolidationLoop: MemoryConsolidationLoop;
}

export class Harness {
  private heartbeat: HeartbeatLoop | undefined;
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
    const loaded = await loadHomieConfig({ cwd, env });
    const lifecycle = new Lifecycle();

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

    const backend = await AiSdkBackend.create({ config: loaded.config, env });
    const sessionStore = new SqliteSessionStore({
      dbPath: `${loaded.config.paths.dataDir}/sessions.db`,
    });
    const scheduler = loaded.config.proactive.enabled
      ? new EventScheduler({ dbPath: `${loaded.config.paths.dataDir}/proactive.db` })
      : undefined;
    const memoryStore = new SqliteMemoryStore({
      dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      embedder: backend.embedder,
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
    const consolidationLoop = new MemoryConsolidationLoop({
      backend: llm,
      store: memoryStore,
      config: loaded.config,
      signal: lifecycle.signal,
    });
    const extractor = createMemoryExtractor({
      backend: llm,
      store: memoryStore,
      embedder: backend.embedder,
      ...(scheduler ? { scheduler } : {}),
      timezone: loaded.config.behavior.sleep.timezone,
      signal: lifecycle.signal,
    });
    const engine = new TurnEngine({
      config: loaded.config,
      backend: llm,
      tools,
      promptSkills,
      sessionStore,
      memoryStore,
      extractor,
      ...(scheduler ? { eventScheduler: scheduler } : {}),
      signal: lifecycle.signal,
      trackBackground: lifecycle.track.bind(lifecycle),
      onSuccessfulTurn: () => lifecycle.markSuccessfulTurn(),
      telemetry: telemetryStore,
    });

    const h = new Harness(
      {
        configPath: loaded.configPath,
        config: loaded.config,
        backend,
        llm,
        engine,
        lifecycle,
        sessionStore,
        scheduler,
        memoryStore,
        telemetryStore,
        feedbackTracker,
        consolidationLoop,
      },
      env,
    );
    return h;
  }

  public async runChat(): Promise<void> {
    try {
      await runCliChat({ config: this.boot.config, engine: this.boot.engine });
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
      signal: this.boot.lifecycle.signal,
    });
    await this.close({ reason: 'consolidation_complete' });
  }

  public async startRuntime(): Promise<void> {
    const cfg = this.boot.config;
    const channels: Promise<void>[] = [];

    const env = this.env as NodeJS.ProcessEnv & {
      SIGNAL_API_URL?: string;
      SIGNAL_NUMBER?: string;
      SIGNAL_DAEMON_URL?: string;
      SIGNAL_HTTP_URL?: string;
      TELEGRAM_BOT_TOKEN?: string;
    };

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
      throw new Error('No channels configured. Set SIGNAL_API_URL or TELEGRAM_BOT_TOKEN.');
    }

    if (cfg.proactive.enabled && this.boot.scheduler) {
      this.heartbeat = new HeartbeatLoop({
        scheduler: this.boot.scheduler,
        proactiveConfig: cfg.proactive,
        behaviorConfig: cfg.behavior,
        getLastUserMessageMs: (id) => this.getLastUserMessageMs(String(id)),
        onProactive: async (event) => {
          const out = await this.boot.engine.handleProactiveEvent(event);
          if (out.kind !== 'send_text' || !out.text.trim()) return false;
          await this.sendProactiveText(String(event.chatId), out.text);
          return true;
        },
        signal: this.boot.lifecycle.signal,
      });
      this.heartbeat.start();
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
      void this.close({ reason }).then(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.stdout.write(`homie: starting ${channels.length} channel(s)\n`);
    await Promise.all(channels);
  }

  public async close(opts: { reason: string }): Promise<void> {
    await this.boot.lifecycle.shutdown({
      reason: opts.reason,
      stop: [
        { stop: () => this.heartbeat?.stop() },
        { stop: () => this.boot.feedbackTracker.stop() },
        { stop: () => this.boot.consolidationLoop.stop() },
        { stop: () => this.health?.stop() },
      ],
      drain: [() => this.boot.engine.drain()],
      close: [
        () => this.boot.sessionStore.close(),
        () => this.boot.memoryStore.close(),
        () => this.boot.telemetryStore.close(),
        () => this.boot.feedbackTracker.close(),
        () => this.boot.scheduler?.close(),
      ].filter((c): c is () => void => typeof c === 'function'),
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

  private async sendProactiveText(chatId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const parsed = parseChatId(chatId);
    if (!parsed) return;

    if (parsed.channel === 'cli') {
      process.stdout.write(`[proactive] ${trimmed}\n`);
      return;
    }

    const env = this.env as NodeJS.ProcessEnv & {
      TELEGRAM_BOT_TOKEN?: string;
      SIGNAL_DAEMON_URL?: string;
      SIGNAL_HTTP_URL?: string;
      SIGNAL_API_URL?: string;
      SIGNAL_NUMBER?: string;
    };

    if (parsed.channel === 'telegram') {
      const token = env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) return;
      const brandedChatId = asChatId(chatId);
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
        const messageId = json?.result?.message_id;
        if (typeof messageId === 'number') {
          this.boot.feedbackTracker.onOutgoingSent({
            channel: 'telegram',
            chatId: brandedChatId,
            refKey: makeOutgoingRefKey(brandedChatId, { channel: 'telegram', messageId }),
            isGroup: parsed.kind === 'group',
            sentAtMs: Date.now(),
            text: trimmed,
            primaryChannelUserId: parsed.kind === 'dm' ? `telegram:${parsed.id}` : undefined,
          });
        }
      } catch (err) {
        void err;
      }
      return;
    }

    if (parsed.channel === 'signal') {
      if (env.SIGNAL_DAEMON_URL || env.SIGNAL_HTTP_URL) {
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
            text: trimmed,
            primaryChannelUserId: parsed.kind === 'dm' ? `signal:${parsed.id}` : undefined,
          });
        }
        return;
      }

      const apiUrl = env.SIGNAL_API_URL?.trim();
      const number = env.SIGNAL_NUMBER?.trim();
      if (!apiUrl || !number) return;
      const brandedChatId = asChatId(chatId);
      const body = { message: trimmed, number, recipients: [parsed.id] };
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
          text: trimmed,
          primaryChannelUserId: parsed.kind === 'dm' ? `signal:${parsed.id}` : undefined,
        });
      } catch (err) {
        void err;
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
