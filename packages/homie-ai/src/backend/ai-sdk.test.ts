import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import { datetimeTool } from '../tools/datetime.js';
import { defineTool } from '../tools/define.js';
import { AiSdkBackend } from './ai-sdk.js';

type TestEnv = NodeJS.ProcessEnv & {
  ANTHROPIC_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  MPP_PRIVATE_KEY?: string | undefined;
  MPP_MAX_DEPOSIT?: string | undefined;
  MPP_RPC_URL?: string | undefined;
  HOMIE_AI_TELEMETRY?: string | undefined;
};

const baseConfig = (overrides: Partial<HomieConfig['model']>): HomieConfig => ({
  schemaVersion: 1,
  model: {
    provider: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
    models: { default: 'm', fast: 'mf' },
    ...overrides,
  },
  engine: DEFAULT_ENGINE,
  behavior: {
    sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
    groupMaxChars: 240,
    dmMaxChars: 420,
    minDelayMs: 0,
    maxDelayMs: 0,
    debounceMs: 0,
  },
  proactive: {
    enabled: false,
    heartbeatIntervalMs: 1_800_000,
    dm: {
      maxPerDay: 1,
      maxPerWeek: 3,
      cooldownAfterUserMs: 7_200_000,
      pauseAfterIgnored: 2,
    },
    group: {
      maxPerDay: 1,
      maxPerWeek: 1,
      cooldownAfterUserMs: 12 * 60 * 60_000,
      pauseAfterIgnored: 1,
    },
  },
  memory: DEFAULT_MEMORY,
  tools: {
    restricted: { enabledForOperator: true, allowlist: [] },
    dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
  },
  paths: {
    projectDir: '/tmp',
    identityDir: '/tmp/identity',
    skillsDir: '/tmp/skills',
    dataDir: '/tmp/data',
  },
});

describe('AiSdkBackend', () => {
  test('probes Ollama when baseUrl looks like localhost:11434', async () => {
    let gotUrl = '';
    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async (input) => {
        gotUrl = String(input);
        return new Response('{"version":"x"}', { status: 200 });
      },
      streamTextImpl: ((args: unknown) => {
        // Not used here.
        void args;
        return { text: Promise.resolve('ok') } as never;
      }) as never,
    });
    expect(typeof backend.complete).toBe('function');
    expect(gotUrl).toContain('/api/version');
  });

  test('throws if anthropic provider missing key', async () => {
    const cfg: HomieConfig = baseConfig({ provider: { kind: 'anthropic' } });
    const env = process.env as TestEnv;
    const prev = env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    try {
      await expect(AiSdkBackend.create({ config: cfg, env })).rejects.toThrow(
        'Missing ANTHROPIC_API_KEY',
      );
    } finally {
      if (prev !== undefined) env.ANTHROPIC_API_KEY = prev;
    }
  });

  test('throws for cli-session providers (use backend factory)', async () => {
    const claudeCfg: HomieConfig = baseConfig({ provider: { kind: 'claude-code' } });
    await expect(AiSdkBackend.create({ config: claudeCfg, env: {} })).rejects.toThrow(
      'requires the CLI backend factory',
    );

    const codexCfg: HomieConfig = baseConfig({ provider: { kind: 'codex-cli' } });
    await expect(AiSdkBackend.create({ config: codexCfg, env: {} })).rejects.toThrow(
      'requires the CLI backend factory',
    );
  });

  test('throws if openai-compatible baseUrl is missing', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'openai-compatible' },
        models: { default: 'm', fast: 'mf' },
      },
    };
    await expect(AiSdkBackend.create({ config: cfg, env: {} })).rejects.toThrow('requires baseUrl');
  });

  test('throws if OpenRouter baseUrl but missing OPENROUTER_API_KEY', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
        models: { default: 'm', fast: 'mf' },
      },
    };
    const env = process.env as TestEnv;
    const prev = env.OPENROUTER_API_KEY;
    delete env.OPENROUTER_API_KEY;
    try {
      await expect(AiSdkBackend.create({ config: cfg, env })).rejects.toThrow('OPENROUTER_API_KEY');
    } finally {
      if (prev !== undefined) env.OPENROUTER_API_KEY = prev;
    }
  });

  test('throws if OpenAI baseUrl but missing OPENAI_API_KEY', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
        models: { default: 'm', fast: 'mf' },
      },
    };
    const env = process.env as TestEnv;
    const prev = env.OPENAI_API_KEY;
    delete env.OPENAI_API_KEY;
    try {
      await expect(AiSdkBackend.create({ config: cfg, env })).rejects.toThrow('OPENAI_API_KEY');
    } finally {
      if (prev !== undefined) env.OPENAI_API_KEY = prev;
    }
  });

  test('throws if mpp provider missing MPP_PRIVATE_KEY', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'mpp', baseUrl: 'https://mpp.tempo.xyz' },
        models: { default: 'openai/gpt-4o', fast: 'openai/gpt-4o-mini' },
      },
    };
    const env = process.env as TestEnv;
    const prev = env.MPP_PRIVATE_KEY;
    delete env.MPP_PRIVATE_KEY;
    try {
      await expect(AiSdkBackend.create({ config: cfg, env })).rejects.toThrow('MPP_PRIVATE_KEY');
    } finally {
      if (prev !== undefined) env.MPP_PRIVATE_KEY = prev;
    }
  });

  test('throws if mpp provider key has invalid format', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'mpp', baseUrl: 'https://mpp.tempo.xyz' },
        models: { default: 'openai/gpt-4o', fast: 'openai/gpt-4o-mini' },
      },
    };
    await expect(
      AiSdkBackend.create({
        config: cfg,
        env: { MPP_PRIVATE_KEY: '0xabc' } as TestEnv,
      }),
    ).rejects.toThrow('expected 0x-prefixed 64-byte hex string');
  });

  test('throws if mpp provider is missing MPP_RPC_URL', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'mpp', baseUrl: 'https://mpp.tempo.xyz' },
        models: { default: 'openai/gpt-4o', fast: 'openai/gpt-4o-mini' },
      },
    };
    await expect(
      AiSdkBackend.create({
        config: cfg,
        env: {
          MPP_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
        } as TestEnv,
      }),
    ).rejects.toThrow('Missing MPP_RPC_URL');
  });

  test('throws if MPP_MAX_DEPOSIT is not a positive number', async () => {
    const cfg: HomieConfig = {
      ...baseConfig({}),
      model: {
        provider: { kind: 'mpp', baseUrl: 'https://mpp.tempo.xyz' },
        models: { default: 'openai/gpt-4o', fast: 'openai/gpt-4o-mini' },
      },
    };
    await expect(
      AiSdkBackend.create({
        config: cfg,
        env: {
          MPP_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
          MPP_MAX_DEPOSIT: '0',
        } as TestEnv,
      }),
    ).rejects.toThrow('Invalid MPP_MAX_DEPOSIT');
  });

  test('creates anthropic backend when key present', async () => {
    const cfg: HomieConfig = baseConfig({ provider: { kind: 'anthropic' } });
    const env = process.env as TestEnv;
    const prev = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = 'x';
    try {
      const backend = await AiSdkBackend.create({
        config: cfg,
        env,
        streamTextImpl: ((args: unknown) => {
          void args;
          return { text: Promise.resolve('ok') } as never;
        }) as never,
      });
      const out = await backend.complete({
        role: 'default',
        maxSteps: 1,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
        ],
      });
      expect(out.text).toBe('ok');
    } finally {
      if (prev !== undefined) env.ANTHROPIC_API_KEY = prev;
      else delete env.ANTHROPIC_API_KEY;
    }
  });

  test('maps tool defs into AI SDK tools record', async () => {
    let gotTools: string[] = [];
    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: ((args: { tools?: Record<string, unknown> }) => {
        gotTools = Object.keys(args.tools ?? {});
        return { text: Promise.resolve('  hi  ') } as never;
      }) as never,
    });

    const out = await backend.complete({
      role: 'default',
      maxSteps: 3,
      tools: [datetimeTool],
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    });

    expect(out.text).toBe('hi');
    expect(gotTools).toEqual(['datetime']);
  });

  test('omits tools when no tools are provided', async () => {
    let sawToolsKey = false;
    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: ((args: Record<string, unknown>) => {
        sawToolsKey = Object.hasOwn(args, 'tools');
        return { text: Promise.resolve('ok') } as never;
      }) as never,
    });

    await backend.complete({
      role: 'default',
      maxSteps: 1,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    });

    expect(sawToolsKey).toBe(false);
  });

  test('circuit breaker opens after 5 consecutive failures and falls back to fast model', async () => {
    let callCount = 0;
    const modelsUsed: string[] = [];

    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: ((args: { model?: { modelId?: string } }) => {
        callCount += 1;
        modelsUsed.push(args.model?.modelId ?? 'unknown');
        if (callCount <= 6) throw new Error(`fail-${callCount}`);
        return { text: Promise.resolve('recovered') } as never;
      }) as never,
    });

    for (let i = 0; i < 5; i += 1) {
      await backend
        .complete({
          role: 'default',
          maxSteps: 1,
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch(() => {});
    }

    // 6th call: circuit is now open, should use the fast model
    await backend
      .complete({
        role: 'default',
        maxSteps: 1,
        messages: [{ role: 'user', content: 'x' }],
      })
      .catch(() => {});

    // First 5 calls should use default model 'm', 6th should use fast model 'mf'
    expect(modelsUsed.slice(0, 5).every((m) => m === 'm')).toBe(true);
    expect(modelsUsed[5]).toBe('mf');
  });

  test('circuit breaker resets on successful completion', async () => {
    let callCount = 0;

    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: (() => {
        callCount += 1;
        // Fail calls 1-4, succeed on 5, then fail 6-9, succeed on 10
        if (callCount <= 4) throw new Error(`fail-${callCount}`);
        if (callCount === 5) return { text: Promise.resolve('ok') } as never;
        if (callCount <= 9) throw new Error(`fail-${callCount}`);
        return { text: Promise.resolve('ok') } as never;
      }) as never as never,
    });

    // 4 failures
    for (let i = 0; i < 4; i += 1) {
      await backend
        .complete({
          role: 'default',
          maxSteps: 1,
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch(() => {});
    }

    // Success on 5th - resets counter
    const ok = await backend.complete({
      role: 'default',
      maxSteps: 1,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(ok.text).toBe('ok');

    // 4 more failures (total 4, below threshold of 5)
    for (let i = 0; i < 4; i += 1) {
      await backend
        .complete({
          role: 'default',
          maxSteps: 1,
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch(() => {});
    }

    // 10th call succeeds — circuit never opened because success reset the counter
    const ok2 = await backend.complete({
      role: 'default',
      maxSteps: 1,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(ok2.text).toBe('ok');
    expect(ok2.modelId).toBe('m');
  });

  test('fast role requests are unaffected by circuit breaker state', async () => {
    let callCount = 0;
    const modelsUsed: string[] = [];

    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: ((args: { model?: { modelId?: string } }) => {
        callCount += 1;
        modelsUsed.push(args.model?.modelId ?? 'unknown');
        if (callCount <= 5) throw new Error(`fail-${callCount}`);
        return { text: Promise.resolve('ok') } as never;
      }) as never,
    });

    // Open the circuit with 5 failures
    for (let i = 0; i < 5; i += 1) {
      await backend
        .complete({
          role: 'default',
          maxSteps: 1,
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch(() => {});
    }

    // Fast role call should use fast model (always does, circuit or not)
    const result = await backend.complete({
      role: 'fast',
      maxSteps: 1,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.text).toBe('ok');
    expect(result.modelId).toBe('mf');
  });

  test('abort errors do not increment the circuit breaker', async () => {
    let callCount = 0;
    const modelsUsed: string[] = [];
    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: ((args: { model?: { modelId?: string }; abortSignal?: AbortSignal }) => {
        callCount += 1;
        modelsUsed.push(args.model?.modelId ?? 'unknown');
        if (args.abortSignal?.aborted) {
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        return { text: Promise.resolve('ok') } as never;
      }) as never,
    });

    for (let i = 0; i < 6; i += 1) {
      const controller = new AbortController();
      controller.abort();
      await backend
        .complete({
          role: 'default',
          maxSteps: 1,
          messages: [{ role: 'user', content: 'x' }],
          signal: controller.signal,
        })
        .catch(() => {});
    }

    const out = await backend.complete({
      role: 'default',
      maxSteps: 1,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(callCount).toBe(7);
    expect(out.text).toBe('ok');
    expect(out.modelId).toBe('m');
    expect(modelsUsed.every((model) => model === 'm')).toBeTrue();
  });

  test('covers stopWhen and OPENAI_API_KEY path', async () => {
    const env = process.env as TestEnv;
    const prev = env.OPENAI_API_KEY;
    env.OPENAI_API_KEY = 'k';
    try {
      const cfg: HomieConfig = {
        ...baseConfig({}),
        model: {
          provider: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
          models: { default: 'm', fast: 'mf' },
        },
      };

      const echoTool = defineTool({
        name: 'echo',
        tier: 'safe',
        description: 'echo',
        inputSchema: z.object({ msg: z.string() }),
        execute: ({ msg }) => ({ msg }),
      });

      let sawStopWhen = false;
      let sawToolExecute = false;
      let toolExec: Promise<unknown> | undefined;

      const backend = await AiSdkBackend.create({
        config: cfg,
        env,
        streamTextImpl: ((args: {
          stopWhen?: (p: { steps: unknown[] }) => boolean;
          tools?:
            | { echo?: { execute?: (input: unknown) => Promise<unknown> | unknown } }
            | undefined;
        }) => {
          // Execute the stopWhen callback at least once for coverage.
          if (args.stopWhen) {
            sawStopWhen = true;
            expect(args.stopWhen({ steps: [] })).toBe(false);
            expect(args.stopWhen({ steps: [1] })).toBe(true);
          }

          const toolDef = args.tools?.echo;
          if (toolDef?.execute) {
            sawToolExecute = true;
            toolExec = Promise.resolve(toolDef.execute({ msg: 'hi' }));
          }

          return { text: Promise.resolve(' ok ') } as never;
        }) as never,
      });

      const out = await backend.complete({
        role: 'default',
        maxSteps: 1,
        tools: [echoTool],
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
        ],
      });
      expect(out.text).toBe('ok');
      expect(sawStopWhen).toBe(true);
      expect(sawToolExecute).toBe(true);
      const toolOut = await toolExec;
      if (typeof toolOut === 'string') {
        // Some AI SDK tool wrappers may stringify structured output.
        expect(toolOut).toContain('hi');
      } else {
        expect((toolOut as { msg?: string } | null | undefined)?.msg).toBe('hi');
      }
    } finally {
      if (prev !== undefined) env.OPENAI_API_KEY = prev;
      else delete env.OPENAI_API_KEY;
    }
  });

  test('extracts MPP-style receipt metadata from usage payloads', async () => {
    const txHash = `0x${'a'.repeat(64)}`;
    const encodedProof = Buffer.from(JSON.stringify({ txHash })).toString('base64');
    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: (() => {
        return {
          text: Promise.resolve('ok'),
          totalUsage: Promise.resolve({
            providerMetadata: {
              mpp: {
                paymentProof: encodedProof,
                receipt: { txHash },
              },
            },
            usage: {
              inputTokens: 12,
              outputTokens: 5,
              costUsd: '0.42',
            },
          }),
        } as never;
      }) as never,
    });

    const out = await backend.complete({
      role: 'default',
      maxSteps: 1,
      messages: [{ role: 'user', content: 'receipt pls' }],
    });

    expect(out.text).toBe('ok');
    expect(out.usage?.costUsd).toBe(0.42);
    expect(out.usage?.txHash).toBe(txHash);
  });

  test('streams tool input deltas and step lifecycle callbacks', async () => {
    const seen: {
      text: string[];
      reasoning: string[];
      inputStart: string[];
      inputDelta: string[];
      inputEnd: string[];
      stepFinish: number[];
      finish: number;
    } = {
      text: [],
      reasoning: [],
      inputStart: [],
      inputDelta: [],
      inputEnd: [],
      stepFinish: [],
      finish: 0,
    };

    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: ((args: {
        onStepFinish?: (step: {
          finishReason?: string;
          usage?: unknown;
          steps?: unknown[];
        }) => void;
      }) => {
        args.onStepFinish?.({
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 1 },
          steps: [{}],
        });
        async function* fullStream() {
          yield { type: 'reasoning-delta', text: 'thinking' };
          yield { type: 'tool-input-start', id: 't1', toolName: 'web_search' };
          yield { type: 'tool-input-delta', id: 't1', delta: '{"query":"tempo"}' };
          yield { type: 'tool-input-end', id: 't1' };
          yield {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'web_search',
            input: { query: 'tempo' },
          };
          yield {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'web_search',
            output: { ok: true },
          };
          yield { type: 'text-delta', text: 'hello' };
        }
        return {
          fullStream: fullStream(),
          text: Promise.resolve('hello'),
          totalUsage: Promise.resolve(undefined),
        } as never;
      }) as never,
    });

    const out = await backend.complete({
      role: 'default',
      maxSteps: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: {
        onTextDelta: (delta) => seen.text.push(delta),
        onReasoningDelta: (delta) => seen.reasoning.push(delta),
        onToolInputStart: (event) => seen.inputStart.push(`${event.toolCallId}:${event.toolName}`),
        onToolInputDelta: (event) => seen.inputDelta.push(event.delta),
        onToolInputEnd: (event) => seen.inputEnd.push(`${event.toolCallId}:${event.toolName}`),
        onStepFinish: (event) => seen.stepFinish.push(event.index),
        onFinish: () => {
          seen.finish += 1;
        },
      },
    });

    expect(out.text).toBe('hello');
    expect(seen.text).toEqual(['hello']);
    expect(seen.reasoning).toEqual(['thinking']);
    expect(seen.inputStart).toEqual(['t1:web_search']);
    expect(seen.inputDelta).toEqual(['{"query":"tempo"}']);
    expect(seen.inputEnd).toEqual(['t1:web_search']);
    expect(seen.stepFinish).toEqual([0]);
    expect(seen.finish).toBe(1);
  });

  test('completeObject returns structured output and usage', async () => {
    let sawTelemetry = false;
    const txHash = `0x${'b'.repeat(64)}`;
    const backend = await AiSdkBackend.create({
      config: baseConfig({}),
      env: { HOMIE_AI_TELEMETRY: '1' } as TestEnv,
      fetchImpl: async () => new Response('{"version":"x"}', { status: 200 }),
      streamTextImpl: (() => ({ text: Promise.resolve('ok') }) as never) as never,
      generateTextImpl: ((args: { experimental_telemetry?: unknown }) => {
        sawTelemetry = Boolean(args.experimental_telemetry);
        return Promise.resolve({
          output: { done: true, question: 'next?' },
          totalUsage: {
            inputTokens: 11,
            outputTokens: 4,
            providerMetadata: { mpp: { receipt: { txHash } } },
          },
          providerMetadata: { mpp: { receipt: { txHash } } },
        } as never);
      }) as never,
    });

    const out = await backend.completeObject<{ done: boolean; question: string }>({
      role: 'default',
      messages: [{ role: 'user', content: 'u' }],
      schema: z.object({
        done: z.boolean(),
        question: z.string(),
      }),
    });

    expect(sawTelemetry).toBeTrue();
    expect(out.output.done).toBeTrue();
    expect(out.output.question).toBe('next?');
    expect(out.usage?.inputTokens).toBe(11);
    expect(out.usage?.outputTokens).toBe(4);
    expect(out.usage?.txHash).toBe(txHash);
  });
});
