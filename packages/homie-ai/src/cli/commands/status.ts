import type { LoadedHomieConfig } from '../../config/load.js';
import { SqliteFeedbackStore } from '../../feedback/sqlite.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { SqliteTelemetryStore } from '../../telemetry/sqlite.js';
import type { GlobalOpts } from '../args.js';

export async function runStatusCommand(
  opts: GlobalOpts,
  loadCfg: () => Promise<LoadedHomieConfig>,
): Promise<void> {
  const loaded = await loadCfg();
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
  const memStats = memStore.getStats();
  const feedbackStats = feedbackStore.getStats();
  const usage24h = telemetryStore.getUsageSummary(24 * 60 * 60 * 1000);
  const usage7d = telemetryStore.getUsageSummary(7 * 24 * 60 * 60 * 1000);
  feedbackStore.close();
  telemetryStore.close();
  memStore.close();

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          configPath: loaded.configPath,
          provider: cfg.model.provider.kind,
          modelDefault: cfg.model.models.default,
          modelFast: cfg.model.models.fast,
          identityDir: cfg.paths.identityDir,
          dataDir: cfg.paths.dataDir,
          stores: {
            memory: `${cfg.paths.dataDir}/memory.db`,
            feedback: `${cfg.paths.dataDir}/feedback.db`,
            telemetry: `${cfg.paths.dataDir}/telemetry.db`,
          },
          memory: memStats,
          feedback: feedbackStats,
          usage: { window24h: usage24h, window7d: usage7d },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

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
      `people: ${memStats.people}`,
      `facts: ${memStats.facts}`,
      `episodes: ${memStats.episodes}`,
      `lessons: ${memStats.lessons}`,
      '',
    ].join('\n'),
  );
}
