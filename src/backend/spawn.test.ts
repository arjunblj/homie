import { describe, expect, test } from 'bun:test';
import { classifyError, type SpawnResult, spawnWithTimeouts, splitBufferedLines } from './spawn.js';

const sampleResult = (overrides: Partial<SpawnResult>): SpawnResult => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...overrides,
});

describe('splitBufferedLines', () => {
  test('returns complete lines and a trailing remainder', () => {
    const out = splitBufferedLines('a\nb\npartial');
    expect(out.lines).toEqual(['a', 'b']);
    expect(out.remainder).toBe('partial');
  });
});

describe('classifyError', () => {
  test('marks first-byte timeout correctly', () => {
    const classified = classifyError(sampleResult({ timedOut: 'first-byte' }));
    expect(classified.isFirstByteTimeout).toBeTrue();
    expect(classified.isTransient).toBeFalse();
  });

  test('marks idle/total timeouts as transient', () => {
    expect(classifyError(sampleResult({ timedOut: 'idle' })).isTransient).toBeTrue();
    expect(classifyError(sampleResult({ timedOut: 'total' })).isTransient).toBeTrue();
  });

  test('detects model unavailable failures', () => {
    const classified = classifyError(
      sampleResult({ stderr: 'The model does not exist or you do not have access' }),
    );
    expect(classified.isModelUnavailable).toBeTrue();
  });
});

describe('spawnWithTimeouts', () => {
  test('forwards stdout chunks and succeeds', async () => {
    const chunks: string[] = [];
    const result = await spawnWithTimeouts({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
      timeouts: { firstByteMs: 2_000, idleMs: 2_000, totalMs: 2_000 },
      onStdoutChunk: (chunk) => chunks.push(chunk),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(chunks.join('')).toContain('ok');
  });

  test('honors abort signal', async () => {
    const controller = new AbortController();
    const pending = spawnWithTimeouts({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeouts: { firstByteMs: 10_000, idleMs: 10_000, totalMs: 10_000 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    const result = await pending;
    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  test('handles already-aborted signals when stdin is provided', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await spawnWithTimeouts({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeouts: { firstByteMs: 10_000, idleMs: 10_000, totalMs: 10_000 },
      signal: controller.signal,
      stdin: 'payload',
    });
    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  test('waits for SIGKILL escalation when process ignores SIGTERM', async () => {
    const startedAt = Date.now();
    const result = await spawnWithTimeouts({
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ],
      timeouts: { firstByteMs: 1_000, idleMs: 40, totalMs: 10_000 },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.timedOut).toBe('idle');
    expect(result.code).toBe(1);
    // The timeout path sends SIGTERM, then waits 500ms before SIGKILL.
    expect(elapsedMs).toBeGreaterThanOrEqual(350);
  });

  test('bounds buffered stdout to prevent unbounded growth', async () => {
    const result = await spawnWithTimeouts({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(20000))"],
      timeouts: { firstByteMs: 2_000, idleMs: 2_000, totalMs: 2_000 },
      maxBufferBytes: 2_048,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(2_100);
    expect(result.stdout).toContain('[stdout truncated]');
  });
});
