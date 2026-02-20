import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pc from 'picocolors';

import type { IncomingMessage } from '../../agent/types.js';
import { ClaudeCodeBackend } from '../../backend/claude-code.js';
import { CodexCliBackend } from '../../backend/codex-cli.js';
import type { LLMBackend } from '../../backend/types.js';
import { createDefaultConfig } from '../../config/defaults.js';
import type { HomieConfig, HomieProvider } from '../../config/types.js';
import { MessageAccumulator, ZERO_DEBOUNCE_CONFIG } from '../../engine/accumulator.js';
import { TurnEngine } from '../../engine/turnEngine.js';
import type { OutgoingAction } from '../../engine/types.js';
import {
  buildJudgePrompt,
  INIT_QUALITY_CASES,
  type InitQualityCase,
  JUDGE_SYSTEM_PROMPT,
  TEST_PERSONA,
} from '../../evals/init-quality.js';
import type { IdentityInterviewAnswers } from '../../evals/init-quality-types.js';
import { buildIdentityFromInterview } from '../../evals/init-quality-types.js';
import { detectProviderAvailability } from '../../llm/detect.js';
import { asChatId, asMessageId } from '../../types/ids.js';
import { truncateOneLine } from '../../util/format.js';
import type { GlobalOpts } from '../args.js';

type CliBackendId = 'claude-code' | 'codex-cli';
const VALID_BACKEND_IDS = ['claude-code', 'codex-cli'] as const;
interface CliBackendAvailability {
  hasClaudeCodeCli: boolean;
  hasCodexAuth: boolean;
}

interface BackendEntry {
  id: CliBackendId;
  label: string;
  create: () => LLMBackend;
  providerKind: HomieProvider['kind'];
}

const ALL_BACKENDS: readonly BackendEntry[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    create: () => new ClaudeCodeBackend(),
    providerKind: 'claude-code',
  },
  {
    id: 'codex-cli',
    label: 'Codex CLI',
    create: () => new CodexCliBackend(),
    providerKind: 'codex-cli',
  },
];

interface JudgeScore {
  score: number;
  reasoning: string;
}

interface CaseResult {
  caseId: string;
  title: string;
  scope: 'dm' | 'group';
  input: string;
  outputKind: string;
  outputText?: string | undefined;
  judge?: JudgeScore | undefined;
  error?: string | undefined;
}

interface BackendResult {
  backendId: CliBackendId;
  label: string;
  results: CaseResult[];
  avgScore: number;
}

const writeIdentityFiles = async (
  dir: string,
  answers: IdentityInterviewAnswers,
): Promise<void> => {
  const identity = buildIdentityFromInterview(answers);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'SOUL.md'), `${identity.soul.trim()}\n`, 'utf8'),
    writeFile(path.join(dir, 'STYLE.md'), `${identity.style.trim()}\n`, 'utf8'),
    writeFile(path.join(dir, 'USER.md'), `${identity.user.trim()}\n`, 'utf8'),
    writeFile(path.join(dir, 'first-meeting.md'), `${identity.firstMeeting.trim()}\n`, 'utf8'),
    writeFile(path.join(dir, 'personality.json'), `${identity.personality.trim()}\n`, 'utf8'),
  ]);
};

const buildEvalConfig = (projectDir: string, provider: HomieProvider): HomieConfig => {
  const base = createDefaultConfig(projectDir);
  const models =
    provider.kind === 'claude-code'
      ? { default: 'opus', fast: 'sonnet' }
      : provider.kind === 'codex-cli'
        ? { default: 'gpt-5.3-codex', fast: 'gpt-5.2' }
        : { default: provider.kind, fast: provider.kind };
  return {
    ...base,
    model: {
      provider,
      models,
    },
    behavior: {
      ...base.behavior,
      sleep: { ...base.behavior.sleep, enabled: false },
      minDelayMs: 0,
      maxDelayMs: 0,
    },
    engine: {
      ...base.engine,
      limiter: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
      perChatLimiter: {
        ...base.engine.perChatLimiter,
        capacity: 1_000_000,
        refillPerSecond: 1_000_000,
      },
    },
  };
};

type JudgeMode = { kind: 'openrouter'; apiKey: string; model: string } | { kind: 'cli' };
const DEFAULT_JUDGE_MODEL = 'anthropic/claude-sonnet-4-5';

export const parseJudgeModelArg = (cmdArgs: readonly string[]): string => {
  let judgeModel = DEFAULT_JUDGE_MODEL;
  for (let i = 0; i < cmdArgs.length; i += 1) {
    const arg = cmdArgs[i];
    if (!arg) continue;
    if (arg === '--judge-model') {
      const next = cmdArgs[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('homie eval-init: --judge-model requires a non-empty value');
      }
      judgeModel = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith('--judge-model=')) {
      const value = arg.slice('--judge-model='.length).trim();
      if (!value) {
        throw new Error('homie eval-init: --judge-model requires a non-empty value');
      }
      judgeModel = value;
    }
  }
  return judgeModel;
};

export const parseRequestedBackends = (cmdArgs: readonly string[]): CliBackendId[] => {
  const backendArgs: string[] = [];
  for (let i = 0; i < cmdArgs.length; i += 1) {
    const arg = cmdArgs[i];
    if (!arg) continue;
    if (arg === '--judge-model') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--judge-model=')) continue;
    if (arg.startsWith('--')) continue;
    backendArgs.push(arg);
  }

  const invalidBackendArgs = backendArgs.filter(
    (a) => !(VALID_BACKEND_IDS as readonly string[]).includes(a),
  );
  if (invalidBackendArgs.length > 0) {
    throw new Error(
      `homie eval-init: unknown backend "${invalidBackendArgs[0]}". Expected one of: ${VALID_BACKEND_IDS.join(', ')}`,
    );
  }

  return backendArgs.filter((a): a is CliBackendId =>
    (VALID_BACKEND_IDS as readonly string[]).includes(a),
  );
};

export const resolveBackendAvailability = (
  availability: CliBackendAvailability,
): Record<CliBackendId, boolean> => ({
  'claude-code': availability.hasClaudeCodeCli,
  'codex-cli': availability.hasCodexAuth,
});

const parseJudgeJson = (raw: string): JudgeScore => {
  const jsonMatch = raw.match(/\{[\s\S]*?"score"[\s\S]*?"reasoning"[\s\S]*?\}/u);
  const toParse = jsonMatch ? jsonMatch[0] : raw;
  try {
    const parsed = JSON.parse(toParse) as { score?: unknown; reasoning?: unknown };
    const score = typeof parsed.score === 'number' ? parsed.score : 3;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : raw;
    return { score: Math.max(1, Math.min(5, score)), reasoning };
  } catch {
    return { score: 3, reasoning: `Judge returned unparseable response: ${raw.slice(0, 200)}` };
  }
};

const callJudgeOpenRouter = async (opts: {
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> => {
  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: opts.prompt },
    ],
    temperature: 0,
    max_tokens: 300,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter judge call failed: HTTP ${res.status} ${detail}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? '';
  } finally {
    clearTimeout(timer);
  }
};

const callJudgeCli = async (prompt: string): Promise<string> => {
  const { spawn } = await import('node:child_process');
  const fullPrompt = `${JUDGE_SYSTEM_PROMPT}\n\n${prompt}`;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print', '--output-format', 'json', '--max-turns', '1'], {
      timeout: 60_000,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Claude judge call failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
        return;
      }
      let text = stdout.trim();
      try {
        const parsed = JSON.parse(text) as { result?: unknown };
        if (typeof parsed.result === 'string') text = parsed.result.trim();
      } catch {
        // keep raw
      }
      resolve(text);
    });
    child.on('error', (err) => {
      reject(new Error(`Claude judge call failed: ${err.message}`));
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
};

const callJudge = async (opts: {
  mode: JudgeMode;
  persona: IdentityInterviewAnswers;
  userText: string;
  response: string;
  rubricFocus: string;
}): Promise<JudgeScore> => {
  const prompt = buildJudgePrompt({
    persona: opts.persona,
    userText: opts.userText,
    response: opts.response,
    rubricFocus: opts.rubricFocus,
  });

  const raw =
    opts.mode.kind === 'openrouter'
      ? await callJudgeOpenRouter({
          apiKey: opts.mode.apiKey,
          model: opts.mode.model,
          prompt,
        })
      : await callJudgeCli(prompt);

  return parseJudgeJson(raw);
};

const runCasesForBackend = async (opts: {
  entry: BackendEntry;
  cases: readonly InitQualityCase[];
  projectDir: string;
  judgeMode: JudgeMode;
  persona: IdentityInterviewAnswers;
  json: boolean;
}): Promise<BackendResult> => {
  const provider = { kind: opts.entry.providerKind } as HomieProvider;
  const cfg = buildEvalConfig(opts.projectDir, provider);
  const backend = opts.entry.create();
  const engine = new TurnEngine({
    config: cfg,
    backend,
    accumulator: new MessageAccumulator(ZERO_DEBOUNCE_CONFIG),
  });

  const results: CaseResult[] = [];

  for (const c of opts.cases) {
    const chatId = asChatId(`cli:eval-init:${opts.entry.id}:${c.id}`);
    const msg: IncomingMessage = {
      channel: c.scope === 'group' ? 'signal' : 'cli',
      chatId,
      messageId: asMessageId(`eval-init:${c.id}`),
      authorId: c.scope === 'group' ? '+10000000000' : 'user',
      text: c.userText,
      isGroup: c.scope === 'group',
      isOperator: false,
      ...(c.scope === 'group' ? { mentioned: true } : {}),
      timestampMs: Date.now(),
    };

    let out: OutgoingAction;
    try {
      out = await engine.handleIncomingMessage(msg);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        caseId: c.id,
        title: c.title,
        scope: c.scope,
        input: c.userText,
        outputKind: 'error',
        error: errMsg,
      });
      if (!opts.json) {
        process.stdout.write(`  ${pc.red('✗')} ${c.title}: ${pc.dim(errMsg)}\n`);
      }
      continue;
    }

    const outputText = out.kind === 'send_text' ? out.text : undefined;
    let judge: JudgeScore | undefined;

    if (outputText) {
      try {
        judge = await callJudge({
          mode: opts.judgeMode,
          persona: opts.persona,
          userText: c.userText,
          response: outputText,
          rubricFocus: c.rubricFocus,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        judge = { score: 0, reasoning: `Judge error: ${errMsg}` };
      }
    }

    results.push({
      caseId: c.id,
      title: c.title,
      scope: c.scope,
      input: c.userText,
      outputKind: out.kind,
      ...(outputText ? { outputText } : {}),
      ...(judge ? { judge } : {}),
    });

    if (!opts.json) {
      const scoreLabel = judge
        ? judge.score >= 4
          ? pc.green(`${judge.score}/5`)
          : judge.score >= 3
            ? pc.yellow(`${judge.score}/5`)
            : pc.red(`${judge.score}/5`)
        : pc.dim('n/a');
      const outPreview =
        out.kind === 'send_text'
          ? truncateOneLine(out.text, 120)
          : out.kind === 'react'
            ? out.emoji
            : '(silence)';
      process.stdout.write(`  ${scoreLabel} ${c.title}\n`);
      process.stdout.write(`    ${pc.dim('in:')}  ${truncateOneLine(c.userText, 80)}\n`);
      process.stdout.write(`    ${pc.dim('out:')} ${outPreview}\n`);
      if (judge) {
        process.stdout.write(`    ${pc.dim('why:')} ${truncateOneLine(judge.reasoning, 120)}\n`);
      }
    }
  }

  const scored = results.filter((r) => r.judge && r.judge.score > 0);
  const avgScore =
    scored.length > 0
      ? scored.reduce((sum, r) => sum + (r.judge?.score ?? 0), 0) / scored.length
      : 0;

  return { backendId: opts.entry.id, label: opts.entry.label, results, avgScore };
};

interface EvalInitEnv extends NodeJS.ProcessEnv {
  OPENROUTER_API_KEY?: string;
}

export async function runEvalInitCommand(opts: GlobalOpts, cmdArgs: string[]): Promise<void> {
  const env = process.env as EvalInitEnv;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const judgeModel = parseJudgeModelArg(cmdArgs);

  const availability = await detectProviderAvailability(env, { timeoutMs: 3_000 });

  let judgeMode: JudgeMode;
  if (apiKey) {
    judgeMode = { kind: 'openrouter', apiKey, model: judgeModel };
  } else if (availability.hasClaudeCodeCli) {
    judgeMode = { kind: 'cli' };
  } else {
    process.stderr.write(
      'eval-init requires OPENROUTER_API_KEY or Claude Code CLI for judging.\n' +
        'Set OPENROUTER_API_KEY in .env or install the claude CLI.\n',
    );
    process.exit(1);
  }

  const requestedBackends = parseRequestedBackends(cmdArgs);
  const availableMap = resolveBackendAvailability(availability);
  const unavailableRequested = requestedBackends.filter((backendId) => !availableMap[backendId]);
  if (unavailableRequested.length > 0) {
    const details = unavailableRequested.map((backendId) => {
      if (backendId === 'codex-cli' && availability.hasCodexCli && !availability.hasCodexAuth) {
        return '- codex-cli: CLI detected but not logged in (run `codex login`)';
      }
      if (backendId === 'codex-cli') return '- codex-cli: `codex` CLI not available on PATH';
      return '- claude-code: `claude` CLI not available on PATH';
    });
    process.stderr.write(
      `Requested backend${unavailableRequested.length === 1 ? '' : 's'} unavailable:\n${details.join('\n')}\n`,
    );
    process.exit(1);
  }

  const backendsToRun =
    requestedBackends.length > 0
      ? ALL_BACKENDS.filter((b) => requestedBackends.includes(b.id))
      : ALL_BACKENDS.filter((b) => availableMap[b.id]);

  if (backendsToRun.length === 0) {
    process.stderr.write(
      'No CLI backends available. Install one of: claude, codex\n' +
        'Or specify explicitly: homie eval-init claude-code codex-cli\n',
    );
    process.exit(1);
  }

  const projectDir = path.join(tmpdir(), `homie-eval-init-${Date.now()}`);
  const identityDir = path.join(projectDir, 'identity');
  const skillsDir = path.join(projectDir, 'skills');
  const dataDir = path.join(projectDir, 'data');
  await mkdir(skillsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeIdentityFiles(identityDir, TEST_PERSONA);

  const allResults: BackendResult[] = [];
  let exitCode: number | undefined;
  try {
    if (!opts.json) {
      process.stdout.write(
        `\n${pc.bold('homie eval-init')} — identity quality harness\n\n` +
          `${pc.dim('Persona:')}  ${TEST_PERSONA.friendName} (${TEST_PERSONA.vibe})\n` +
          `${pc.dim('Judge:')}    ${judgeMode.kind === 'openrouter' ? `OpenRouter → ${judgeMode.model}` : 'Claude Code CLI'}\n` +
          `${pc.dim('Backends:')} ${backendsToRun.map((b) => b.label).join(', ')}\n` +
          `${pc.dim('Cases:')}    ${INIT_QUALITY_CASES.length}\n\n`,
      );
    }

    for (const entry of backendsToRun) {
      if (!opts.json) {
        process.stdout.write(`${pc.bold(entry.label)}\n`);
      }

      const result = await runCasesForBackend({
        entry,
        cases: INIT_QUALITY_CASES,
        projectDir,
        judgeMode,
        persona: TEST_PERSONA,
        json: opts.json,
      });
      allResults.push(result);

      if (!opts.json) {
        const avg = result.avgScore.toFixed(1);
        const color = result.avgScore >= 4 ? pc.green : result.avgScore >= 3 ? pc.yellow : pc.red;
        process.stdout.write(`  ${pc.dim('avg:')} ${color(avg)}/5\n\n`);
      }
    }

    if (opts.json) {
      const output = {
        persona: TEST_PERSONA.friendName,
        judge: judgeMode.kind === 'openrouter' ? `openrouter:${judgeMode.model}` : 'claude-cli',
        backends: allResults.map((r) => ({
          id: r.backendId,
          label: r.label,
          avgScore: Math.round(r.avgScore * 10) / 10,
          results: r.results,
        })),
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`${pc.bold('Summary')}\n`);
      const sorted = [...allResults].sort((a, b) => b.avgScore - a.avgScore);
      for (const r of sorted) {
        const avg = r.avgScore.toFixed(1);
        const bar = '█'.repeat(Math.round(r.avgScore));
        const color = r.avgScore >= 4 ? pc.green : r.avgScore >= 3 ? pc.yellow : pc.red;
        process.stdout.write(`  ${r.label.padEnd(14)} ${color(bar)} ${avg}/5\n`);
      }
      process.stdout.write('\n');
    }

    const anyFail = allResults.some((r) => r.avgScore < 3);
    if (anyFail) exitCode = 2;
  } finally {
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
  if (exitCode !== undefined) process.exit(exitCode);
}
