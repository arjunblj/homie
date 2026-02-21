#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const USAGE = `create-openhomie - bootstrap a new openhomie friend project

Usage:
  bun create openhomie <directory> [--yes|-y] [--force]
`;

const parseArgs = (
  argv: readonly string[],
): { targetDir: string; opts: { yes: boolean; force: boolean } } => {
  let targetDir = '';
  let yes = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === '--yes' || arg === '-y') {
      yes = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (!targetDir) {
      targetDir = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!targetDir) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(1);
  }

  return { targetDir, opts: { yes, force } };
};

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
  const { targetDir, opts } = parseArgs(process.argv.slice(2));
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
