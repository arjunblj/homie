import { createBackend } from '../../backend/factory.js';
import type { LoadedOpenhomieConfig } from '../../config/load.js';
import { SqliteFeedbackStore } from '../../feedback/sqlite.js';
import { FeedbackTracker } from '../../feedback/tracker.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { planGapAnalysis } from '../../ops/gap-analysis.js';
import type { GlobalOpts } from '../args.js';

const parseLimit = (raw: string): number => {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('homie gap-analysis: --limit must be a positive integer');
  }
  return parsed;
};

export const parseGapAnalysisArgs = (
  cmdArgs: readonly string[],
): { apply: boolean; limit: number } => {
  let apply = false;
  let limit = 25;
  for (let i = 0; i < cmdArgs.length; i += 1) {
    const a = cmdArgs[i];
    if (!a) continue;
    if (a === '--apply') {
      apply = true;
      continue;
    }
    if (a === '--dry-run') {
      apply = false;
      continue;
    }
    if (a === '--limit') {
      const next = cmdArgs[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('homie gap-analysis: --limit requires a value');
      }
      limit = parseLimit(next);
      i += 1;
      continue;
    }
    if (a.startsWith('--limit=')) {
      const raw = a.slice('--limit='.length).trim();
      if (!raw) throw new Error('homie gap-analysis: --limit requires a value');
      limit = parseLimit(raw);
    }
  }
  return { apply, limit };
};

export async function runGapAnalysisCommand(
  opts: GlobalOpts,
  cmdArgs: readonly string[],
  loadCfg: () => Promise<LoadedOpenhomieConfig>,
): Promise<void> {
  const loaded = await loadCfg();
  const cfg = loaded.config;
  const nowMs = Date.now();

  const { apply, limit } = parseGapAnalysisArgs(cmdArgs);

  const store = new SqliteFeedbackStore({ dbPath: `${cfg.paths.dataDir}/feedback.db` });
  if (!apply) {
    const plan = planGapAnalysis({
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

    process.stdout.write(`gap-analysis dry-run (${plan.length} due)\n`);
    for (const entry of plan) {
      const s = entry.score.toFixed(2);
      process.stdout.write(
        `- id=${entry.outgoingId} score=${s} lesson=${entry.willLogLesson ? 'yes' : 'no'} text="${entry.textPreview}"\n`,
      );
    }
    return;
  }

  if (!cfg.memory.enabled || !cfg.memory.feedback.enabled) {
    store.close();
    process.stderr.write('homie gap-analysis: memory.feedback is disabled in config\n');
    process.exit(1);
  }

  try {
    const { backend } = await createBackend({ config: cfg, env: process.env });
    const memory = new SqliteMemoryStore({ dbPath: `${cfg.paths.dataDir}/memory.db` });
    let tracker: FeedbackTracker | null = null;
    try {
      tracker = new FeedbackTracker({ store, backend, memory, config: cfg });
      const count = await tracker.tick(nowMs, limit);
      process.stdout.write(`gap-analysis applied (${count} finalized)\n`);
    } finally {
      tracker?.close();
      memory.close();
    }
  } finally {
    store.close();
  }
}
