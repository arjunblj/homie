#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { parseArgs } from './args.js';

const require = createRequire(import.meta.url);

const resolveHomieCommand = (): { command: string; prefixArgs: string[] } => {
  try {
    const packageJsonPath = require.resolve('openhomie/package.json');
    const homieCliPath = path.join(path.dirname(packageJsonPath), 'dist', 'cli.js');
    return { command: process.execPath, prefixArgs: [homieCliPath] };
  } catch (_err) {
    return {
      command: process.platform === 'win32' ? 'homie.cmd' : 'homie',
      prefixArgs: [],
    };
  }
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(`${parsed.usage}\n`);
    process.exit(parsed.exitCode);
  }
  if (parsed.kind === 'error') {
    throw new Error(parsed.message);
  }

  const { targetDir, opts } = parsed;
  const configPath = path.join(path.resolve(targetDir), 'homie.toml');
  const cliArgs = ['init', '--config', configPath];
  if (opts.force) cliArgs.push('--force');
  if (opts.yes) cliArgs.push('--yes');
  const { command, prefixArgs } = resolveHomieCommand();
  const targetCwd = path.resolve(targetDir);
  await mkdir(targetCwd, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...prefixArgs, ...cliArgs], {
      stdio: 'inherit',
      cwd: targetCwd,
    });
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null) return;
      try {
        child.kill(signal);
      } catch (_err) {
        // Process already exited.
      }
    };
    const onSigint = (): void => forwardSignal('SIGINT');
    const onSigterm = (): void => forwardSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    const cleanup = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`homie init exited with code ${code ?? 'unknown'}`));
    });
  });
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`create-openhomie: ${msg}\n`);
  process.exit(1);
});
