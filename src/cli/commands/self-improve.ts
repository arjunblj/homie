import crypto from 'node:crypto';

import { createBackend } from '../../backend/factory.js';
import type { LoadedOpenhomieConfig } from '../../config/load.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { planSelfImprove } from '../../ops/self-improve/planner.js';
import { runSelfImproveItem } from '../../ops/self-improve/runner.js';
import { SelfImproveSqliteStore } from '../../ops/self-improve/sqlite.js';
import type { GlobalOpts } from '../args.js';

type SelfImproveCmd = 'plan' | 'run' | 'status';

const parseIntFlag = (flag: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`homie self-improve: ${flag} must be a positive integer`);
  return n;
};

const parseFloatFlag = (flag: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`homie self-improve: ${flag} must be a number`);
  return n;
};

const parseSelfImproveArgs = (
  cmdArgs: readonly string[],
): {
  subcmd: SelfImproveCmd;
  apply: boolean;
  limit: number;
  minConfidence: number;
  allowMd: boolean;
  openPr: boolean;
} => {
  const first = cmdArgs[0];
  const subcmd: SelfImproveCmd =
    first === 'run' || first === 'status' || first === 'plan' ? first : 'plan';
  let apply = false;
  let limit = 5;
  let minConfidence = 0.55;
  let allowMd = false;
  let openPr = true;

  for (let i = 0; i < cmdArgs.length; i += 1) {
    const a = cmdArgs[i];
    if (!a) continue;
    if (i === 0 && (a === 'plan' || a === 'run' || a === 'status')) continue;
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
      if (!next || next.startsWith('--'))
        throw new Error('homie self-improve: --limit requires a value');
      limit = parseIntFlag('--limit', next);
      i += 1;
      continue;
    }
    if (a.startsWith('--limit=')) {
      limit = parseIntFlag('--limit', a.slice('--limit='.length).trim());
      continue;
    }
    if (a === '--min-confidence') {
      const next = cmdArgs[i + 1];
      if (!next || next.startsWith('--'))
        throw new Error('homie self-improve: --min-confidence requires a value');
      minConfidence = parseFloatFlag('--min-confidence', next);
      i += 1;
      continue;
    }
    if (a.startsWith('--min-confidence=')) {
      minConfidence = parseFloatFlag(
        '--min-confidence',
        a.slice('--min-confidence='.length).trim(),
      );
      continue;
    }
    if (a === '--allow-md') {
      allowMd = true;
      continue;
    }
    if (a === '--no-pr') {
      openPr = false;
    }
  }

  minConfidence = Math.max(0, Math.min(1, minConfidence));
  limit = Math.max(1, Math.min(25, limit));

  // Default: status doesn't mutate, run/plan default to dry-run unless --apply is set.
  if (subcmd === 'status') apply = false;

  return { subcmd, apply, limit, minConfidence, allowMd, openPr };
};

export async function runSelfImproveCommand(
  opts: GlobalOpts,
  cmdArgs: readonly string[],
  loadCfg: () => Promise<LoadedOpenhomieConfig>,
): Promise<void> {
  const loaded = await loadCfg();
  const cfg = loaded.config;
  const { subcmd, apply, limit, minConfidence, allowMd, openPr } = parseSelfImproveArgs(cmdArgs);

  const store = new SelfImproveSqliteStore({ dbPath: `${cfg.paths.dataDir}/self-improve.db` });
  const memory = new SqliteMemoryStore({ dbPath: `${cfg.paths.dataDir}/memory.db` });

  try {
    if (subcmd === 'status') {
      const pending = store.list({ status: 'pending', limit: 50 });
      const inProgress = store.list({ status: 'in_progress', limit: 50 });
      const completed = store.list({ status: 'completed', limit: 10 });
      const deferred = store.list({ status: 'deferred', limit: 10 });
      const out = {
        pending: pending.length,
        in_progress: inProgress.length,
        completed: completed.length,
        deferred: deferred.length,
        latest: [...pending, ...inProgress].slice(0, 10).map((i) => ({
          id: i.id,
          status: i.status,
          classification: i.classification,
          confidence: i.confidence,
          title: i.title,
        })),
      };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    if (subcmd === 'plan') {
      const cursorRaw = store.getMeta('planner.last_lesson_id');
      const lastLessonId = cursorRaw ? Number(cursorRaw) : 0;
      const lessons = await memory.getLessons('behavioral_feedback', 200);
      const newLessons = lessons
        .filter((l) => typeof l.id === 'number' && l.id > lastLessonId)
        .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));

      if (newLessons.length === 0) {
        process.stdout.write('self-improve plan: no new lessons\n');
        return;
      }

      const { backend } = await createBackend({ config: cfg, env: process.env });
      const plan = await planSelfImprove({ backend, lessons: newLessons, maxItems: limit });

      if (opts.json || !apply) {
        process.stdout.write(`${JSON.stringify({ apply, lastLessonId, plan }, null, 2)}\n`);
        return;
      }

      let inserted = 0;
      for (const draft of plan.planned) {
        const res = store.insertDraft(draft);
        if (res.ok) inserted += 1;
      }
      const maxId = Math.max(...newLessons.map((l) => Number(l.id ?? 0)));
      store.setMeta('planner.last_lesson_id', String(maxId));
      process.stdout.write(`self-improve plan: inserted ${inserted} items (cursor=${maxId})\n`);
      return;
    }

    // run
    if (!apply) {
      const next = store.list({ status: 'pending', limit: 1 })[0];
      process.stdout.write(`${JSON.stringify({ dryRun: true, next }, null, 2)}\n`);
      return;
    }

    const claimId = crypto.randomBytes(12).toString('hex');
    const claimed = store.claimNext({ claimId, leaseMs: 30 * 60_000, minConfidence });
    if (!claimed) {
      process.stdout.write('self-improve run: no pending items\n');
      return;
    }

    const { backend } = await createBackend({ config: cfg, env: process.env });
    const res = await runSelfImproveItem({
      backend,
      repoDir: cfg.paths.projectDir,
      item: claimed,
      allowMd,
      openPr,
      baseBranch: 'main',
      remote: 'origin',
    });

    if (!res.ok) {
      store.defer({ id: claimed.id, reason: res.error });
      process.stderr.write(`self-improve run failed for item ${claimed.id}: ${res.error}\n`);
      process.exit(1);
    }

    store.complete({ id: claimed.id, prUrl: res.prUrl });
    process.stdout.write(
      `self-improve run complete: item ${claimed.id}${res.prUrl ? ` pr=${res.prUrl}` : ''}\n`,
    );
  } finally {
    memory.close();
    store.close();
  }
}
