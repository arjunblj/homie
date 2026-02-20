import { execFile } from 'node:child_process';
import { MPP_KEY_PATTERN } from '../util/mpp.js';

export interface ProviderAvailability {
  hasClaudeCodeCli: boolean;
  hasCodexCli: boolean;
  hasCodexAuth: boolean;
  hasAnthropicKey: boolean;
  hasOpenRouterKey: boolean;
  hasOpenAiKey: boolean;
  hasMppPrivateKey: boolean;
}

export interface DetectCliOptions {
  timeoutMs?: number;
}

export type InitProvider =
  | 'claude-code'
  | 'codex-cli'
  | 'anthropic'
  | 'openrouter'
  | 'openai'
  | 'mpp'
  | 'ollama';

interface ExecResult {
  code: number;
  stdout: string;
}

type ExecLike = (command: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

const defaultExec: ExecLike = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: process.env }, (err, stdout) => {
      resolve({
        code: err ? 1 : 0,
        stdout: stdout.trim(),
      });
    });
  });

const canRun = async (
  command: string,
  args: string[],
  opts?: DetectCliOptions,
  execImpl: ExecLike = defaultExec,
): Promise<boolean> => {
  const result = await execImpl(command, args, opts?.timeoutMs ?? 2_500);
  return result.code === 0;
};

const canRunCodexLoginStatus = async (
  opts?: DetectCliOptions,
  execImpl: ExecLike = defaultExec,
): Promise<boolean> => {
  const result = await execImpl('codex', ['login', 'status'], opts?.timeoutMs ?? 4_000);
  return result.code === 0;
};

export const detectProviderAvailability = async (
  env: NodeJS.ProcessEnv = process.env,
  opts?: DetectCliOptions,
  execImpl: ExecLike = defaultExec,
): Promise<ProviderAvailability> => {
  interface DetectEnv extends NodeJS.ProcessEnv {
    ANTHROPIC_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    OPENAI_API_KEY?: string;
    MPP_PRIVATE_KEY?: string;
  }
  const scopedEnv = env as DetectEnv;

  const [hasClaudeCodeCli, hasCodexCli] = await Promise.all([
    canRun('claude', ['--version'], opts, execImpl),
    canRun('codex', ['--version'], opts, execImpl),
  ]);
  const hasCodexAuth = hasCodexCli ? await canRunCodexLoginStatus(opts, execImpl) : false;

  return {
    hasClaudeCodeCli,
    hasCodexCli,
    hasCodexAuth,
    hasAnthropicKey: Boolean(scopedEnv.ANTHROPIC_API_KEY?.trim()),
    hasOpenRouterKey: Boolean(scopedEnv.OPENROUTER_API_KEY?.trim()),
    hasOpenAiKey: Boolean(scopedEnv.OPENAI_API_KEY?.trim()),
    hasMppPrivateKey: MPP_KEY_PATTERN.test(scopedEnv.MPP_PRIVATE_KEY?.trim() ?? ''),
  };
};

export const recommendInitProvider = (
  availability: ProviderAvailability,
  opts?: { ollamaDetected?: boolean | undefined },
): InitProvider | null => {
  if (availability.hasClaudeCodeCli) return 'claude-code';
  if (availability.hasCodexAuth) return 'codex-cli';
  if (availability.hasOpenRouterKey) return 'openrouter';
  if (availability.hasAnthropicKey) return 'anthropic';
  if (availability.hasOpenAiKey) return 'openai';
  if (availability.hasMppPrivateKey) return 'mpp';
  if (opts?.ollamaDetected) return 'ollama';
  return null;
};
