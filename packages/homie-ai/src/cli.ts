#!/usr/bin/env node

import { AiSdkBackend } from './backend/ai-sdk.js';
import { runCliChat } from './channels/cli.js';
import { runSignalAdapter } from './channels/signal.js';
import { runTelegramAdapter } from './channels/telegram.js';
import { loadHomieConfig } from './config/load.js';
import { TurnEngine } from './engine/turnEngine.js';
import { createMemoryExtractor } from './memory/extractor.js';
import { HttpMemoryStore } from './memory/http.js';
import { SqliteMemoryStore } from './memory/sqlite.js';
import { SqliteSessionStore } from './session/sqlite.js';
import { createToolRegistry, getToolsForTier } from './tools/registry.js';

const USAGE: string = `homie — open-source runtime for AI friends

Usage:
  homie chat         Interactive CLI chat (operator mode)
  homie start        Start all configured channels (Signal, Telegram)
  homie status       Show config, model, and memory stats
  homie export       Export memory as JSON to stdout
  homie forget <id>  Forget a person (delete person + facts, keep episodes)
  homie --help       Show this help

Environment:
  ANTHROPIC_API_KEY         Anthropic API key (recommended)
  OPENROUTER_API_KEY        OpenRouter key (if using OpenRouter)
  SIGNAL_API_URL            Signal CLI REST API base URL (signal-cli-rest-api)
  SIGNAL_DAEMON_URL         signal-cli daemon base URL (HTTP JSON-RPC + SSE)
  SIGNAL_NUMBER             Your Signal phone number
  SIGNAL_OPERATOR_NUMBER    Operator's Signal number (optional)
  TELEGRAM_BOT_TOKEN        Telegram bot token
  TELEGRAM_OPERATOR_CHAT_ID Operator's Telegram chat ID (optional)
  BRAVE_API_KEY             Brave Search API key (optional)
  HOMIE_MEMORY_HTTP_URL     Madhav memory service base URL (optional)
  HOMIE_MEMORY_HTTP_TOKEN   Bearer token for memory HTTP adapter (optional)
`;

const args: string[] = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const cmd = args[0] ?? 'chat';

const boot = async (): Promise<{
  engine: TurnEngine;
  config: ReturnType<typeof loadHomieConfig> extends Promise<infer R> ? R : never;
}> => {
  const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
  const toolReg = await createToolRegistry({ skillsDir: loaded.config.paths.skillsDir });
  const tools = getToolsForTier(toolReg, ['safe']);

  const backend = await AiSdkBackend.create({ config: loaded.config, env: process.env });
  const sessionStore = new SqliteSessionStore({
    dbPath: `${loaded.config.paths.dataDir}/sessions.db`,
  });
  const memUrl = process.env['HOMIE_MEMORY_HTTP_URL']?.trim();
  const memToken =
    process.env['HOMIE_MEMORY_HTTP_TOKEN']?.trim() ?? process.env['MEMORY_SERVICE_TOKEN']?.trim();
  const memoryStore = memUrl
    ? new HttpMemoryStore({ baseUrl: memUrl, token: memToken })
    : new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
        embedder: backend.embedder,
      });
  const extractor = memUrl
    ? undefined
    : createMemoryExtractor({ backend, store: memoryStore, embedder: backend.embedder });
  const engine = new TurnEngine({
    config: loaded.config,
    backend,
    tools,
    sessionStore,
    memoryStore,
    extractor,
  });

  return { engine, config: loaded };
};

const main = async (): Promise<void> => {
  switch (cmd) {
    case 'chat': {
      const { engine, config } = await boot();
      await runCliChat({ config: config.config, engine });
      break;
    }

    case 'start': {
      const { engine, config } = await boot();
      const cfg = config.config;
      const channels: Promise<void>[] = [];

      interface StartEnv extends NodeJS.ProcessEnv {
        SIGNAL_API_URL?: string;
        SIGNAL_DAEMON_URL?: string;
        SIGNAL_HTTP_URL?: string;
        TELEGRAM_BOT_TOKEN?: string;
      }
      const env = process.env as StartEnv;

      if (env.SIGNAL_API_URL || env.SIGNAL_DAEMON_URL || env.SIGNAL_HTTP_URL) {
        channels.push(runSignalAdapter({ config: cfg, engine }));
      }
      if (env.TELEGRAM_BOT_TOKEN) {
        channels.push(runTelegramAdapter({ config: cfg, engine }));
      }

      if (channels.length === 0) {
        process.stderr.write(
          'homie: no channels configured. Set SIGNAL_API_URL or TELEGRAM_BOT_TOKEN.\n',
        );
        process.exit(1);
      }

      // Graceful shutdown.
      const shutdown = (): void => {
        process.stdout.write('\nhomie: shutting down\n');
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      process.stdout.write(`homie: starting ${channels.length} channel(s)\n`);
      await Promise.all(channels);
      break;
    }

    case 'status': {
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const cfg = loaded.config;
      const memUrl = process.env['HOMIE_MEMORY_HTTP_URL']?.trim();
      const memToken =
        process.env['HOMIE_MEMORY_HTTP_TOKEN']?.trim() ??
        process.env['MEMORY_SERVICE_TOKEN']?.trim();

      let memoryLine = `memory: sqlite (${cfg.paths.dataDir}/memory.db)`;
      let people = 0;
      let facts = 0;
      let episodes = 0;
      let lessons = 0;

      if (memUrl) {
        memoryLine = `memory: http (${memUrl})`;
        try {
          const res = await fetch(`${memUrl.replace(/\/+$/u, '')}/stats`, {
            headers: memToken ? { Authorization: `Bearer ${memToken}` } : {},
          });
          if (res.ok) {
            const raw = (await res.json()) as Record<string, unknown>;
            people = Number(raw['people'] ?? 0);
            facts = Number(raw['facts'] ?? 0);
            episodes = Number(raw['episodes'] ?? 0);
            lessons = Number(raw['lessons'] ?? 0);
          }
        } catch {
          /* best-effort stats fetch — failure is non-fatal */
        }
      } else {
        const memStore = new SqliteMemoryStore({
          dbPath: `${cfg.paths.dataDir}/memory.db`,
        });
        interface ExportShape {
          people: unknown[];
          facts: unknown[];
          episodes: unknown[];
          lessons: unknown[];
        }
        const exported = (await memStore.exportJson()) as ExportShape;
        people = exported.people.length;
        facts = exported.facts.length;
        episodes = exported.episodes.length;
        lessons = exported.lessons.length;
      }

      process.stdout.write(
        [
          `config: ${loaded.configPath}`,
          `provider: ${cfg.model.provider.kind}`,
          `model.default: ${cfg.model.models.default}`,
          `model.fast: ${cfg.model.models.fast}`,
          `identity: ${cfg.paths.identityDir}`,
          `data: ${cfg.paths.dataDir}`,
          memoryLine,
          `people: ${people}`,
          `facts: ${facts}`,
          `episodes: ${episodes}`,
          `lessons: ${lessons}`,
          '',
        ].join('\n'),
      );
      break;
    }

    case 'export': {
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const memUrl = process.env['HOMIE_MEMORY_HTTP_URL']?.trim();
      if (memUrl) {
        process.stderr.write('homie export: not supported for HOMIE_MEMORY_HTTP_URL\n');
        process.exit(1);
      }
      const memStore = new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      });
      const data = await memStore.exportJson();
      process.stdout.write(JSON.stringify(data, null, 2));
      process.stdout.write('\n');
      break;
    }

    case 'forget': {
      const personId = args[1];
      if (!personId) {
        process.stderr.write('homie forget: missing person ID\n');
        process.exit(1);
      }
      const memUrl = process.env['HOMIE_MEMORY_HTTP_URL']?.trim();
      if (memUrl) {
        process.stderr.write('homie forget: not supported for HOMIE_MEMORY_HTTP_URL\n');
        process.exit(1);
      }
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const memStore = new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      });
      await memStore.deletePerson(personId);
      process.stdout.write(`Deleted person "${personId}" and associated facts.\n`);
      break;
    }

    default:
      process.stderr.write(`homie: unknown command "${cmd}"\n\n${USAGE}\n`);
      process.exit(1);
  }
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`homie: ${msg}\n`);
  process.exit(1);
});
