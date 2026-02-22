import { describe, expect, test } from 'bun:test';

import type { TelemetryStore } from '../telemetry/types.js';
import { createInstrumentedBackend } from './instrumented.js';
import type { LLMBackend } from './types.js';

const throwingTelemetry = (): TelemetryStore => ({
  ping() {},
  close() {},
  logTurn() {},
  logSlop() {},
  logLlmCall() {
    throw new Error('telemetry boom');
  },
  getUsageSummary(windowMs) {
    return {
      windowMs,
      turns: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
  },
  getLlmUsageSummary(windowMs) {
    return {
      windowMs,
      turns: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
  },
});

describe('createInstrumentedBackend', () => {
  test('does not fail successful completions when telemetry throws', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: 'ok', steps: [], usage: { inputTokens: 1, outputTokens: 2 } };
      },
    };
    const llm = createInstrumentedBackend({ backend, telemetry: throwingTelemetry() });

    const res = await llm.complete({
      role: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      maxSteps: 1,
    });
    expect(res.text).toBe('ok');
  });

  test('propagates backend errors even when telemetry throws', async () => {
    const backend: LLMBackend = {
      async complete() {
        throw new Error('llm failed');
      },
    };
    const llm = createInstrumentedBackend({ backend, telemetry: throwingTelemetry() });

    await expect(
      llm.complete({
        role: 'default',
        messages: [{ role: 'user', content: 'hi' }],
        maxSteps: 1,
      }),
    ).rejects.toThrow('llm failed');
  });
});
