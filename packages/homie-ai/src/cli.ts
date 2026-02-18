#!/usr/bin/env node

import { loadHomieConfig } from './config/load.js';
import { SqliteFeedbackStore } from './feedback/sqlite.js';
import { runMain } from './harness/harness.js';
import { SqliteMemoryStore } from './memory/sqlite.js';
import { SqliteSessionStore } from './session/sqlite.js';
import { SqliteTelemetryStore } from './telemetry/sqlite.js';
import { errorFields, log } from './util/logger.js';

const USAGE: string = `homie — open-source runtime for AI friends

Usage:
  homie chat         Interactive CLI chat (operator mode)
  homie start        Start all configured channels (Signal, Telegram)
  homie consolidate  Run memory consolidation once
  homie status       Show config, model, and memory stats
  homie doctor       Check config, env vars, and SQLite stores
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
  TELEGRAM_OPERATOR_USER_ID Operator's Telegram user ID (optional)
  BRAVE_API_KEY             Brave Search API key (optional)
`;

const args: string[] = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const cmd = args[0] ?? 'chat';

const main = async (): Promise<void> => {
  if (cmd === 'chat' || cmd === 'start' || cmd === 'consolidate') {
    await runMain(cmd, args);
    return;
  }

  switch (cmd) {
    case 'status': {
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const cfg = loaded.config;

      const memStore = new SqliteMemoryStore({
        dbPath: `${cfg.paths.dataDir}/memory.db`,
      });
      const feedbackStore = new SqliteFeedbackStore({
        dbPath: `${cfg.paths.dataDir}/feedback.db`,
      });
      const telemetryStore = new SqliteTelemetryStore({
        dbPath: `${cfg.paths.dataDir}/telemetry.db`,
      });
      interface ExportShape {
        people: unknown[];
        facts: unknown[];
        episodes: unknown[];
        lessons: unknown[];
      }
      const exported = (await memStore.exportJson()) as ExportShape;
      const feedbackStats = feedbackStore.getStats();
      const usage24h = telemetryStore.getUsageSummary(24 * 60 * 60 * 1000);
      const usage7d = telemetryStore.getUsageSummary(7 * 24 * 60 * 60 * 1000);
      feedbackStore.close();
      telemetryStore.close();
      memStore.close();

      process.stdout.write(
        [
          `config: ${loaded.configPath}`,
          `provider: ${cfg.model.provider.kind}`,
          `model.default: ${cfg.model.models.default}`,
          `model.fast: ${cfg.model.models.fast}`,
          `identity: ${cfg.paths.identityDir}`,
          `data: ${cfg.paths.dataDir}`,
          `memory: sqlite (${cfg.paths.dataDir}/memory.db)`,
          `feedback: sqlite (${cfg.paths.dataDir}/feedback.db)`,
          `telemetry: sqlite (${cfg.paths.dataDir}/telemetry.db)`,
          `feedback.pending: ${feedbackStats.pending}`,
          `feedback.total: ${feedbackStats.total}`,
          `usage.24h.turns: ${usage24h.turns}`,
          `usage.24h.llmCalls: ${usage24h.llmCalls}`,
          `usage.24h.inTokens: ${usage24h.inputTokens}`,
          `usage.24h.outTokens: ${usage24h.outputTokens}`,
          `usage.7d.turns: ${usage7d.turns}`,
          `usage.7d.llmCalls: ${usage7d.llmCalls}`,
          `usage.7d.inTokens: ${usage7d.inputTokens}`,
          `usage.7d.outTokens: ${usage7d.outputTokens}`,
          `people: ${exported.people.length}`,
          `facts: ${exported.facts.length}`,
          `episodes: ${exported.episodes.length}`,
          `lessons: ${exported.lessons.length}`,
          '',
        ].join('\n'),
      );
      break;
    }

    case 'doctor': {
      const issues: string[] = [];
      const warns: string[] = [];

      interface DoctorEnv extends NodeJS.ProcessEnv {
        ANTHROPIC_API_KEY?: string;
        OPENAI_BASE_URL?: string;
        OPENROUTER_API_KEY?: string;
        TELEGRAM_BOT_TOKEN?: string;
        SIGNAL_DAEMON_URL?: string;
        SIGNAL_HTTP_URL?: string;
        SIGNAL_API_URL?: string;
        BRAVE_API_KEY?: string;
      }
      const env = process.env as DoctorEnv;

      let loaded: Awaited<ReturnType<typeof loadHomieConfig>> | null = null;
      try {
        loaded = await loadHomieConfig({ cwd: process.cwd(), env });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`config: ${msg}`);
      }

      if (loaded) {
        const cfg = loaded.config;
        process.stdout.write(`config: ${loaded.configPath}\n`);

        // Provider sanity checks (keys only; avoid network calls in doctor by default).
        if (cfg.model.provider.kind === 'anthropic') {
          if (!env.ANTHROPIC_API_KEY?.trim()) {
            issues.push('model: missing ANTHROPIC_API_KEY');
          }
        } else {
          const baseUrl = cfg.model.provider.baseUrl ?? env.OPENAI_BASE_URL;
          if (!baseUrl) issues.push('model: missing model.base_url / OPENAI_BASE_URL');
          if (String(baseUrl ?? '').includes('openrouter.ai') && !env.OPENROUTER_API_KEY?.trim()) {
            issues.push('model: missing OPENROUTER_API_KEY');
          }
        }

        // SQLite stores
        try {
          const sessions = new SqliteSessionStore({ dbPath: `${cfg.paths.dataDir}/sessions.db` });
          const memory = new SqliteMemoryStore({ dbPath: `${cfg.paths.dataDir}/memory.db` });
          const feedback = new SqliteFeedbackStore({ dbPath: `${cfg.paths.dataDir}/feedback.db` });
          const telemetry = new SqliteTelemetryStore({
            dbPath: `${cfg.paths.dataDir}/telemetry.db`,
          });
          sessions.ping();
          memory.ping();
          feedback.ping();
          telemetry.ping();
          telemetry.close();
          feedback.close();
          memory.close();
          sessions.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push(`sqlite: ${msg}`);
        }

        // Channels are env-driven for now; warn if nothing is configured.
        const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
        const hasSignal = Boolean(
          env.SIGNAL_DAEMON_URL?.trim() ||
            env.SIGNAL_HTTP_URL?.trim() ||
            env.SIGNAL_API_URL?.trim(),
        );
        if (!hasTelegram && !hasSignal) {
          warns.push(
            'channels: neither Telegram nor Signal configured (set TELEGRAM_BOT_TOKEN and/or SIGNAL_* env vars)',
          );
        }

        if (env.BRAVE_API_KEY?.trim() === undefined || env.BRAVE_API_KEY?.trim() === '') {
          warns.push('tools: web_search disabled (set BRAVE_API_KEY)');
        }
      }

      if (warns.length) {
        process.stdout.write('\nWarnings:\n');
        for (const w of warns) process.stdout.write(`- ${w}\n`);
      }
      if (issues.length) {
        process.stderr.write('\nIssues:\n');
        for (const i of issues) process.stderr.write(`- ${i}\n`);
      }

      process.stdout.write(`\nResult: ${issues.length ? 'FAIL' : warns.length ? 'WARN' : 'OK'}\n`);
      if (issues.length) process.exit(1);
      break;
    }

    case 'export': {
      const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
      const memStore = new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      });
      const data = await memStore.exportJson();
      memStore.close();
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
      const memStore = new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      });
      await memStore.deletePerson(personId);
      memStore.close();
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
  log.fatal('cli.crash', errorFields(err));
  process.stderr.write(`homie: ${msg}\n`);
  process.exit(1);
});
