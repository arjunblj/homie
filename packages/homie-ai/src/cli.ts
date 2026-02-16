#!/usr/bin/env node

import { AgentRuntime } from './agent/runtime.js';
import { runCliChat } from './channels/cli.js';
import { runSignalAdapter } from './channels/signal.js';
import { runTelegramAdapter } from './channels/telegram.js';
import { loadHomieConfig } from './config/load.js';
import { createProviderRegistry } from './llm/registry.js';
import { SqliteMemoryLiteStore } from './memory/sqlite-lite.js';
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
  SIGNAL_API_URL            Signal CLI REST API base URL
  SIGNAL_NUMBER             Your Signal phone number
  SIGNAL_OPERATOR_NUMBER    Operator's Signal number (optional)
  TELEGRAM_BOT_TOKEN        Telegram bot token
  TELEGRAM_OPERATOR_CHAT_ID Operator's Telegram chat ID (optional)
  BRAVE_API_KEY             Brave Search API key (optional)
`;

const args: string[] = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const cmd = args[0] ?? 'chat';

const boot = async (): Promise<{
  runtime: AgentRuntime;
  config: ReturnType<typeof loadHomieConfig> extends Promise<infer R> ? R : never;
}> => {
  const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
  const providers = await createProviderRegistry({ config: loaded.config, env: process.env });
  const toolReg = createToolRegistry();
  const tools = getToolsForTier(toolReg, ['safe']);

  const runtime = new AgentRuntime({
    config: loaded.config,
    providers,
    tools,
  });

  return { runtime, config: loaded };
};

const main = async (): Promise<void> => {
  switch (cmd) {
    case 'chat': {
      const { runtime, config } = await boot();
      await runCliChat({ config: config.config, runtime });
      break;
    }

    case 'start': {
      const { runtime, config } = await boot();
      const cfg = config.config;
      const channels: Promise<void>[] = [];

      interface StartEnv extends NodeJS.ProcessEnv {
        SIGNAL_API_URL?: string;
        TELEGRAM_BOT_TOKEN?: string;
      }
      const env = process.env as StartEnv;

      if (env.SIGNAL_API_URL) {
        channels.push(runSignalAdapter({ config: cfg, runtime }));
      }
      if (env.TELEGRAM_BOT_TOKEN) {
        channels.push(runTelegramAdapter({ config: cfg, runtime }));
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
      const memStore = new SqliteMemoryLiteStore({
        dbPath: `${cfg.paths.dataDir}/memory.db`,
      });
      interface ExportShape {
        people: unknown[];
        facts: unknown[];
        episodes: unknown[];
        lessons: unknown[];
      }
      const exported = (await memStore.exportJson()) as ExportShape;

      process.stdout.write(
        [
          `config: ${loaded.configPath}`,
          `provider: ${cfg.model.provider.kind}`,
          `model.default: ${cfg.model.models.default}`,
          `model.fast: ${cfg.model.models.fast}`,
          `identity: ${cfg.paths.identityDir}`,
          `data: ${cfg.paths.dataDir}`,
          `people: ${exported.people.length}`,
          `facts: ${exported.facts.length}`,
          `episodes: ${exported.episodes.length}`,
          `lessons: ${exported.lessons.length}`,
          '',
        ].join('\n'),
      );
      break;
    }

    case 'export': {
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const memStore = new SqliteMemoryLiteStore({
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
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const memStore = new SqliteMemoryLiteStore({
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
