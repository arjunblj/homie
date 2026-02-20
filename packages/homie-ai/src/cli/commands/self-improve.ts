import { AiSdkBackend } from '../../backend/ai-sdk.js';
import type { LoadedHomieConfig } from '../../config/load.js';
import { SqliteFeedbackStore } from '../../feedback/sqlite.js';
import { FeedbackTracker } from '../../feedback/tracker.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { planFeedbackSelfImprove } from '../../ops/self-improve.js';
import type { GlobalOpts } from '../args.js';

export async function runSelfImproveCommand(
  opts: GlobalOpts,
  cmdArgs: readonly string[],
  loadCfg: () => Promise<LoadedHomieConfig>,
): Promise<void> {
  const loaded = await loadCfg();
  const cfg = loaded.config;
  const nowMs = Date.now();

  let apply = false;
  let limit = 25;
  for (let i = 0; i < cmdArgs.length; i += 1) {
    const a = cmdArgs[i];
    if (!a) continue;
    if (a === '--apply') apply = true;
    if (a === '--dry-run') apply = false;
    if (a === '--limit') {
      const next = cmdArgs[i + 1];
      if (next) {
        limit = Number(next);
        i += 1;
      }
    }
    if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length));
  }

  const store = new SqliteFeedbackStore({ dbPath: `${cfg.paths.dataDir}/feedback.db` });
  if (!apply) {
    const plan = planFeedbackSelfImprove({
      store,
      config: {
        enabled: Boolean(cfg.memory.enabled && cfg.memory.feedback.enabled),
        finalizeAfterMs: cfg.memory.feedback.finalizeAfterMs,
        successThreshold: cfg.memory.feedback.successThreshold,
        failureThreshold: cfg.memory.feedback.failureThreshold,
      },
      nowMs,
      limit,
    });
    store.close();

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ nowMs, plan }, null, 2)}\n`);
      return;
    }

    process.stdout.write(`self-improve dry-run (${plan.length} due)\n`);
    for (const p of plan) {
      const s = p.score.toFixed(2);
      process.stdout.write(
        `- id=${p.outgoingId} score=${s} lesson=${p.willLogLesson ? 'yes' : 'no'} text="${p.textPreview}"\n`,
      );
    }
    return;
  }

  if (!cfg.memory.enabled || !cfg.memory.feedback.enabled) {
    store.close();
    process.stderr.write('homie self-improve: memory.feedback is disabled in config\n');
    process.exit(1);
  }

  const backend = await AiSdkBackend.create({ config: cfg, env: process.env });
  const memory = new SqliteMemoryStore({ dbPath: `${cfg.paths.dataDir}/memory.db` });
  const tracker = new FeedbackTracker({ store, backend, memory, config: cfg });
  const count = await tracker.tick(nowMs, limit);
  tracker.close();
  memory.close();
  process.stdout.write(`self-improve applied (${count} finalized)\n`);
}
