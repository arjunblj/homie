import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { LLMBackend } from '../../backend/types.js';
import { extractJsonObject } from '../../interview/json.js';
import { log } from '../../util/logger.js';
import type { SelfImproveItem } from './types.js';

const PatchOutputSchema = z.object({
  patch: z.string().min(1),
});

const normalizeSlug = (s: string): string => {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/(^-|-$)/gu, '')
    .slice(0, 50);
};

const run = async (opts: {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<{ code: number; stdout: string; stderr: string }> => {
  const { spawn } = await import('node:child_process');

  return await new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${opts.command} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
};

const changedPaths = async (repoDir: string): Promise<string[]> => {
  const res = await run({
    cwd: repoDir,
    command: 'git',
    args: ['diff', '--name-only'],
    timeoutMs: 30_000,
  });
  if (res.code !== 0) throw new Error(`git diff failed: ${res.stderr || res.stdout}`);
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
};

const ensureClean = async (repoDir: string): Promise<void> => {
  const res = await run({
    cwd: repoDir,
    command: 'git',
    args: ['status', '--porcelain=v1'],
    timeoutMs: 30_000,
  });
  if (res.code !== 0) throw new Error(`git status failed: ${res.stderr || res.stdout}`);
  if (res.stdout.trim().length > 0) {
    throw new Error('self-improve runner requires a clean worktree');
  }
};

const allowedChange = (filePath: string, allowMd: boolean): boolean => {
  if (!allowMd && filePath.endsWith('.md')) return false;
  if (filePath.startsWith('src/')) return true;
  if (filePath.startsWith('packages/')) return true;
  if (filePath === 'package.json' || filePath === 'bun.lock') return true;
  return false;
};

export interface RunSelfImproveParams {
  backend: LLMBackend;
  repoDir: string;
  item: SelfImproveItem;
  allowMd: boolean;
  openPr: boolean;
  baseBranch: string;
  remote: string;
}

export async function runSelfImproveItem(params: RunSelfImproveParams): Promise<
  | {
      ok: true;
      prUrl?: string | undefined;
    }
  | { ok: false; error: string }
> {
  const claimLabel = `item:${params.item.id}`;
  const branch = `self-improve/${String(params.item.id)}-${normalizeSlug(params.item.title)}`;
  const worktreeDir = path.join(
    params.repoDir,
    '.worktrees',
    `self-improve-${String(params.item.id)}-${Date.now()}`,
  );

  try {
    await ensureClean(params.repoDir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    const add = await run({
      cwd: params.repoDir,
      command: 'git',
      args: ['worktree', 'add', '-b', branch, worktreeDir, params.baseBranch],
      timeoutMs: 60_000,
    });
    if (add.code !== 0) {
      return { ok: false, error: `git worktree add failed: ${add.stderr || add.stdout}` };
    }

    const contextFiles = (params.item.filesHint ?? []).slice(0, 12);
    const fileContext: string[] = [];
    for (const rel of contextFiles) {
      const safeRel = rel.replace(/^\//u, '').trim();
      if (!safeRel) continue;
      const abs = path.join(worktreeDir, safeRel);
      try {
        const raw = await readFile(abs, 'utf8');
        const clipped = raw.length > 30_000 ? `${raw.slice(0, 30_000)}\n/* truncated */\n` : raw;
        fileContext.push(`--- file: ${safeRel}\n${clipped}`);
      } catch (_err) {
        // Best-effort: if a file doesn't exist, ignore.
      }
    }

    const prompt = [
      'You are an autonomous engineer improving the openhomie codebase.',
      '',
      'Task:',
      `- Title: ${params.item.title}`,
      `- Why: ${params.item.why}`,
      `- Proposal: ${params.item.proposal}`,
      '',
      'Hard constraints:',
      '- Output ONLY a unified diff patch string (git-style). No markdown fences.',
      '- Make the smallest change that achieves the goal.',
      '- Do not add or modify planning docs.',
      '- Do not modify files outside src/, packages/, package.json, or bun.lock.',
      ...(params.allowMd ? [] : ['- Do not add or modify any .md files.']),
      '',
      'Context (best-effort):',
      ...fileContext,
      '',
      `Label: ${claimLabel}`,
    ].join('\n');

    let patch: string;
    if (params.backend.completeObject) {
      type PatchOutput = z.infer<typeof PatchOutputSchema>;
      const { output } = await params.backend.completeObject<PatchOutput>({
        role: 'default',
        schema: PatchOutputSchema,
        messages: [
          { role: 'system', content: 'You output only JSON.' },
          { role: 'user', content: prompt },
        ],
      });
      patch = output.patch;
    } else {
      const res = await params.backend.complete({
        role: 'default',
        maxSteps: 1,
        messages: [
          { role: 'system', content: 'You output only JSON.' },
          { role: 'user', content: prompt },
        ],
      });
      const raw = extractJsonObject(res.text);
      const parsed = PatchOutputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `patch parse failed: ${parsed.error.message}` };
      }
      patch = parsed.data.patch;
    }

    const patchPath = path.join(os.tmpdir(), `openhomie-self-improve-${Date.now()}.patch`);
    await writeFile(patchPath, patch, 'utf8');
    try {
      const apply = await run({
        cwd: worktreeDir,
        command: 'git',
        args: ['apply', '--whitespace=fix', patchPath],
        timeoutMs: 60_000,
      });
      if (apply.code !== 0) {
        return { ok: false, error: `git apply failed: ${apply.stderr || apply.stdout}` };
      }
    } finally {
      await rm(patchPath, { force: true });
    }

    const files = await changedPaths(worktreeDir);
    const disallowed = files.filter((f) => !allowedChange(f, params.allowMd));
    if (disallowed.length > 0) {
      return { ok: false, error: `disallowed file changes: ${disallowed.join(', ')}` };
    }

    const lint = await run({
      cwd: worktreeDir,
      command: 'bun',
      args: ['run', 'lint'],
      timeoutMs: 180_000,
    });
    if (lint.code !== 0) return { ok: false, error: `lint failed: ${lint.stderr || lint.stdout}` };
    const tc = await run({
      cwd: worktreeDir,
      command: 'bun',
      args: ['run', 'typecheck'],
      timeoutMs: 240_000,
    });
    if (tc.code !== 0) return { ok: false, error: `typecheck failed: ${tc.stderr || tc.stdout}` };
    const tests = await run({
      cwd: worktreeDir,
      command: 'bun',
      args: ['run', 'test'],
      timeoutMs: 240_000,
    });
    if (tests.code !== 0)
      return { ok: false, error: `tests failed: ${tests.stderr || tests.stdout}` };

    const msg = `chore(ops): self-improve ${params.item.title}`.slice(0, 70);
    const commit = await run({
      cwd: worktreeDir,
      command: 'git',
      args: ['add', '.'],
      timeoutMs: 30_000,
    });
    if (commit.code !== 0)
      return { ok: false, error: `git add failed: ${commit.stderr || commit.stdout}` };
    const doCommit = await run({
      cwd: worktreeDir,
      command: 'git',
      args: ['commit', '-m', msg],
      timeoutMs: 60_000,
    });
    if (doCommit.code !== 0)
      return { ok: false, error: `git commit failed: ${doCommit.stderr || doCommit.stdout}` };

    const push = await run({
      cwd: worktreeDir,
      command: 'git',
      args: ['push', '-u', params.remote, 'HEAD'],
      timeoutMs: 120_000,
    });
    if (push.code !== 0)
      return { ok: false, error: `git push failed: ${push.stderr || push.stdout}` };

    if (!params.openPr) return { ok: true };

    const pr = await run({
      cwd: worktreeDir,
      command: 'gh',
      args: [
        'pr',
        'create',
        '--base',
        params.baseBranch,
        '--title',
        `self-improve: ${params.item.title}`.slice(0, 120),
        '--body',
        [
          '## Summary',
          `- ${params.item.why}`,
          '',
          '## Test plan',
          '- bun run lint',
          '- bun run typecheck',
          '- bun run test',
          '',
          `Queue item: ${params.item.id}`,
        ].join('\n'),
      ],
      timeoutMs: 120_000,
    });
    if (pr.code !== 0)
      return { ok: false, error: `gh pr create failed: ${pr.stderr || pr.stdout}` };
    const url = pr.stdout
      .trim()
      .split('\n')
      .find((l) => l.startsWith('http'))
      ?.trim();
    return { ok: true, prUrl: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('self_improve.run.failed', { itemId: params.item.id, error: msg });
    return { ok: false, error: msg };
  } finally {
    try {
      const remove = await run({
        cwd: params.repoDir,
        command: 'git',
        args: ['worktree', 'remove', '--force', worktreeDir],
        timeoutMs: 60_000,
      });
      if (remove.code !== 0) {
        // If removal fails, don't throw; caller can clean up manually.
        log.warn('self_improve.worktree_remove.failed', {
          stderr: remove.stderr,
          stdout: remove.stdout,
        });
      }
    } catch (_err) {
      // Best-effort: ignore cleanup failures.
    }
  }
}
