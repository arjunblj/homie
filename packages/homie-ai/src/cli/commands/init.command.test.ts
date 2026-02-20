import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GlobalOpts } from '../args.js';
import { runInitCommand } from './init.js';

interface TestEnv extends NodeJS.ProcessEnv {
  ANTHROPIC_API_KEY?: string;
}

const baseOpts = (configPath: string): GlobalOpts => ({
  help: false,
  json: false,
  force: false,
  interactive: false,
  yes: true,
  verifyMpp: false,
  configPath,
});

describe('runInitCommand (non-interactive)', () => {
  test('writes config and env example when config does not exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-init-noninteractive-'));
    const configPath = path.join(dir, 'homie.toml');
    const env = process.env as TestEnv;
    const previousAnthropic = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await runInitCommand(baseOpts(configPath));

      const cfg = await readFile(configPath, 'utf8');
      const envExample = await readFile(path.join(dir, '.env.example'), 'utf8');
      expect(cfg).toContain('schema_version = 1');
      expect(cfg).toContain('[model]');
      expect(envExample).toContain('ANTHROPIC_API_KEY=');
      expect(envExample).toContain('OPENROUTER_API_KEY=');
      expect(envExample).toContain('MPP_PRIVATE_KEY=0x');
    } finally {
      if (previousAnthropic === undefined) delete env.ANTHROPIC_API_KEY;
      else env.ANTHROPIC_API_KEY = previousAnthropic;
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('exits with code 1 when config exists without --force', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-init-existing-'));
    const configPath = path.join(dir, 'homie.toml');
    await writeFile(configPath, 'schema_version = 1\n', 'utf8');

    const proc = process as NodeJS.Process & { exit: (code?: number) => never };
    const originalExit = proc.exit;
    const codes: number[] = [];
    proc.exit = ((code?: number): never => {
      codes.push(code ?? 0);
      throw new Error(`EXIT_${String(code ?? 0)}`);
    }) as never;

    try {
      await expect(runInitCommand(baseOpts(configPath))).rejects.toThrow('EXIT_1');
      expect(codes).toEqual([1]);
    } finally {
      proc.exit = originalExit;
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
