import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { HomieConfig } from '../config/types.js';
import { datetimeTool } from '../tools/datetime.js';
import { defineTool } from '../tools/define.js';
import { AiSdkBackend } from './ai-sdk.js';

type TestEnv = NodeJS.ProcessEnv & {
  ANTHROPIC_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
};

const baseConfig = (overrides: Partial<HomieConfig['model']>): HomieConfig => ({
  schemaVersion: 1,
  model: {
    provider: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
    models: { default: 'm', fast: 'mf' },
    ...overrides,
  },
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
    maxPerDay: 1,
    maxPerWeek: 3,
    cooldownAfterUserMs: 7_200_000,
    pauseAfterIgnored: 2,
  },
  tools: { shell: false },
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
      const toolOut = (await toolExec) as { msg?: string };
      expect(toolOut.msg).toBe('hi');
    } finally {
      if (prev !== undefined) env.OPENAI_API_KEY = prev;
      else delete env.OPENAI_API_KEY;
    }
  });
});
