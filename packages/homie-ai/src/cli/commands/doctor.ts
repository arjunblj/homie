import type { LoadedHomieConfig } from '../../config/load.js';
import { SqliteFeedbackStore } from '../../feedback/sqlite.js';
import { getIdentityPaths } from '../../identity/load.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { SqliteSessionStore } from '../../session/sqlite.js';
import { SqliteTelemetryStore } from '../../telemetry/sqlite.js';
import { fileExists } from '../../util/fs.js';
import type { GlobalOpts } from '../args.js';

export async function runDoctorCommand(
  opts: GlobalOpts,
  loadCfg: () => Promise<LoadedHomieConfig>,
): Promise<void> {
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

  let loaded: LoadedHomieConfig | null = null;
  try {
    loaded = await loadCfg();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`config: ${msg}`);
  }

  if (loaded) {
    const cfg = loaded.config;
    if (!opts.json) process.stdout.write(`config: ${loaded.configPath}\n`);

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

    // Identity files
    try {
      const paths = getIdentityPaths(cfg.paths.identityDir);
      const required = [
        paths.soulPath,
        paths.stylePath,
        paths.userPath,
        paths.firstMeetingPath,
        paths.personalityPath,
      ];
      for (const p of required) {
        if (!(await fileExists(p))) issues.push(`identity: missing ${p}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`identity: ${msg}`);
    }

    // Channels are env-driven for now; warn if nothing is configured.
    const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
    const hasSignal = Boolean(
      env.SIGNAL_DAEMON_URL?.trim() || env.SIGNAL_HTTP_URL?.trim() || env.SIGNAL_API_URL?.trim(),
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

  const result = issues.length ? 'FAIL' : warns.length ? 'WARN' : 'OK';
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          result,
          ...(loaded ? { configPath: loaded.configPath } : {}),
          warnings: warns,
          issues,
        },
        null,
        2,
      )}\n`,
    );
    if (issues.length) process.exit(1);
    return;
  }

  if (warns.length) {
    process.stdout.write('\nWarnings:\n');
    for (const w of warns) process.stdout.write(`- ${w}\n`);
  }
  if (issues.length) {
    process.stderr.write('\nIssues:\n');
    for (const i of issues) process.stderr.write(`- ${i}\n`);
  }

  process.stdout.write(`\nResult: ${result}\n`);
  if (issues.length) process.exit(1);
}
