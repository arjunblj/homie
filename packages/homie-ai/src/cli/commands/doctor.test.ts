import { describe, expect, spyOn, test } from 'bun:test';

import { resolveSignalDaemonUrl, runDoctorCommand } from './doctor.js';

const baseOpts = {
  help: false,
  json: true,
  force: false,
  interactive: false,
  yes: false,
  verifyMpp: false,
  verbose: false,
  quiet: false,
  noColor: true,
} as const;

describe('cli/commands/doctor', () => {
  test('exports runDoctorCommand as a function', () => {
    expect(typeof runDoctorCommand).toBe('function');
  });

  test('reports config load failure with init hint in JSON mode', async () => {
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      chunks.push(String(args[0]));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      await runDoctorCommand(baseOpts, async () => {
        throw new Error('Could not find homie.toml');
      });

      const json = JSON.parse(chunks.join(''));
      expect(json.result).toBe('FAIL');
      expect(json.issues).toHaveLength(1);
      expect(json.issues[0]).toContain('Could not find homie.toml');
      expect(json.issues[0]).toContain('Run `homie init`');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('reports generic config error without init hint in JSON mode', async () => {
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      chunks.push(String(args[0]));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      await runDoctorCommand(baseOpts, async () => {
        throw new Error('invalid schema');
      });

      const json = JSON.parse(chunks.join(''));
      expect(json.result).toBe('FAIL');
      expect(json.issues[0]).toBe('config: invalid schema');
      expect(json.issues[0]).not.toContain('homie init');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('flags missing MPP_RPC_URL when provider is mpp', async () => {
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      chunks.push(String(args[0]));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const env = process.env as NodeJS.ProcessEnv & {
      MPP_RPC_URL?: string;
      MPP_PRIVATE_KEY?: string;
      HOMIE_AGENT_KEY?: string;
    };
    const prevRpc = env.MPP_RPC_URL;
    const prevMppKey = env.MPP_PRIVATE_KEY;
    const prevAgentKey = env.HOMIE_AGENT_KEY;
    delete env.MPP_RPC_URL;
    delete env.MPP_PRIVATE_KEY;
    delete env.HOMIE_AGENT_KEY;

    try {
      await runDoctorCommand(baseOpts, async () => ({
        configPath: '/tmp/homie.toml',
        config: {
          schemaVersion: 1,
          model: {
            provider: { kind: 'mpp', baseUrl: 'https://mpp.tempo.xyz' },
            models: { default: 'openai/gpt-4o', fast: 'openai/gpt-4o-mini' },
          },
          engine: {
            limiter: { capacity: 10, refillPerSecond: 1 },
            perChatLimiter: {
              capacity: 5,
              refillPerSecond: 1,
              staleAfterMs: 300000,
              sweepInterval: 1000,
            },
            session: { fetchLimit: 50 },
            context: {
              maxTokensDefault: 8000,
              identityPromptMaxTokens: 1600,
              promptSkillsMaxTokens: 600,
            },
            generation: { reactiveMaxSteps: 8, proactiveMaxSteps: 3, maxRegens: 2 },
          },
          behavior: {
            sleep: { enabled: true, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
            groupMaxChars: 240,
            dmMaxChars: 420,
            minDelayMs: 1000,
            maxDelayMs: 2000,
            debounceMs: 500,
          },
          proactive: {
            enabled: false,
            heartbeatIntervalMs: 1800000,
            dm: { maxPerDay: 2, maxPerWeek: 5, cooldownAfterUserMs: 60000, pauseAfterIgnored: 2 },
            group: {
              maxPerDay: 2,
              maxPerWeek: 5,
              cooldownAfterUserMs: 60000,
              pauseAfterIgnored: 2,
            },
          },
          memory: {
            enabled: true,
            contextBudgetTokens: 2000,
            capsule: { enabled: true, maxTokens: 200 },
            decay: { enabled: true, halfLifeDays: 30 },
            retrieval: { rrfK: 60, ftsWeight: 0.6, vecWeight: 0.4, recencyWeight: 0.2 },
            feedback: {
              enabled: true,
              finalizeAfterMs: 7200000,
              successThreshold: 0.6,
              failureThreshold: -0.3,
            },
            consolidation: {
              enabled: true,
              intervalMs: 21600000,
              modelRole: 'default',
              maxEpisodesPerRun: 100,
              dirtyGroupLimit: 10,
              dirtyPublicStyleLimit: 10,
              dirtyPersonLimit: 10,
            },
          },
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
        },
      }));

      const json = JSON.parse(chunks.join(''));
      expect(json.result).toBe('FAIL');
      expect(json.issues).toContain('model: missing MPP_RPC_URL');
    } finally {
      if (prevRpc === undefined) delete env.MPP_RPC_URL;
      else env.MPP_RPC_URL = prevRpc;
      if (prevMppKey === undefined) delete env.MPP_PRIVATE_KEY;
      else env.MPP_PRIVATE_KEY = prevMppKey;
      if (prevAgentKey === undefined) delete env.HOMIE_AGENT_KEY;
      else env.HOMIE_AGENT_KEY = prevAgentKey;
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('resolveSignalDaemonUrl', () => {
  test('prefers SIGNAL_DAEMON_URL and trims trailing slash', () => {
    expect(
      resolveSignalDaemonUrl({
        SIGNAL_DAEMON_URL: 'http://localhost:8080/',
        SIGNAL_HTTP_URL: 'http://localhost:8081',
        SIGNAL_API_URL: 'http://localhost:8082',
      }),
    ).toBe('http://localhost:8080');
  });

  test('falls back through SIGNAL_HTTP_URL then SIGNAL_API_URL', () => {
    expect(
      resolveSignalDaemonUrl({
        SIGNAL_DAEMON_URL: '   ',
        SIGNAL_HTTP_URL: 'http://localhost:8081/',
        SIGNAL_API_URL: 'http://localhost:8082',
      }),
    ).toBe('http://localhost:8081');

    expect(
      resolveSignalDaemonUrl({
        SIGNAL_DAEMON_URL: '',
        SIGNAL_HTTP_URL: '',
        SIGNAL_API_URL: 'http://localhost:8082/',
      }),
    ).toBe('http://localhost:8082');
  });
});
