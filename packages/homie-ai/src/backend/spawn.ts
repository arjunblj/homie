import { spawn } from 'node:child_process';

export interface SpawnTimeouts {
  firstByteMs: number;
  idleMs: number;
  totalMs: number;
}

export type TimeoutKind = 'first-byte' | 'idle' | 'total' | false;

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: TimeoutKind;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  timeouts: SpawnTimeouts;
  stdin?: string | undefined;
  signal?: AbortSignal | undefined;
  onStdoutChunk?: ((chunk: string) => void) | undefined;
}

export const DEFAULT_TIMEOUTS: Readonly<SpawnTimeouts> = {
  firstByteMs: 15_000,
  idleMs: 45_000,
  totalMs: 120_000,
};

export function spawnWithTimeouts(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let gotFirstByte = false;
    let timedOut: TimeoutKind = false;
    let settled = false;
    let terminationRequested = false;
    let abortImmediately = false;
    let cleanupAbortListener: (() => void) | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanupAbortListener?.();
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    };

    const killAndFinish = (reason: TimeoutKind): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      timedOut = reason;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already exited.
        }
      }, 500);
    };

    const child = spawn(opts.command, opts.args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const firstByteTimer = setTimeout(() => {
      if (!gotFirstByte) killAndFinish('first-byte');
    }, opts.timeouts.firstByteMs);

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killAndFinish('idle'), opts.timeouts.idleMs);
    };

    const totalTimer = setTimeout(() => killAndFinish('total'), opts.timeouts.totalMs);

    if (opts.signal) {
      const onAbort = (): void => killAndFinish(false);
      if (opts.signal.aborted) {
        abortImmediately = true;
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      cleanupAbortListener = () => {
        opts.signal?.removeEventListener('abort', onAbort);
      };
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!gotFirstByte) {
        gotFirstByte = true;
        clearTimeout(firstByteTimer);
      }
      resetIdleTimer();
      opts.onStdoutChunk?.(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!gotFirstByte) {
        gotFirstByte = true;
        clearTimeout(firstByteTimer);
      }
      resetIdleTimer();
    });

    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      stderr += err.message;
      finish(1);
    });

    if (abortImmediately) {
      killAndFinish(false);
    } else if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

export function splitBufferedLines(buffer: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let rest = buffer;
  let idx = rest.indexOf('\n');
  while (idx !== -1) {
    lines.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
    idx = rest.indexOf('\n');
  }
  return { lines, remainder: rest };
}

export function parseNdjsonLines(raw: string): unknown[] {
  const results: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // Skip non-JSON lines (ANSI escape sequences, progress noise).
    }
  }
  return results;
}

const TRANSIENT_ERROR =
  /network.?timeout|timed out|connection.?(reset|refused)|econnreset|temporar|rate.?limit|429|502|503|504|overloaded/iu;

const MODEL_UNAVAILABLE =
  /model.*does not exist|not supported|do not have access|not available|upgrade.*plan/iu;

export interface ErrorClassification {
  isTransient: boolean;
  isModelUnavailable: boolean;
  isFirstByteTimeout: boolean;
}

export function classifyError(result: SpawnResult): ErrorClassification {
  const detail = result.stderr || result.stdout;
  return {
    isTransient:
      result.timedOut === 'idle' || result.timedOut === 'total' || TRANSIENT_ERROR.test(detail),
    isModelUnavailable: MODEL_UNAVAILABLE.test(detail),
    isFirstByteTimeout: result.timedOut === 'first-byte',
  };
}
