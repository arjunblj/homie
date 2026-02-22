export const USAGE = `create-openhomie - bootstrap a new openhomie friend project

Usage:
  bun create openhomie <directory> [--yes|-y] [--force]
`;

export type CreateOpenhomieOpts = { yes: boolean; force: boolean };

export type ParseArgsResult =
  | { kind: 'ok'; targetDir: string; opts: CreateOpenhomieOpts }
  | { kind: 'help'; exitCode: 0 | 1; usage: string }
  | { kind: 'error'; exitCode: 1; usage: string; message: string };

export const parseArgs = (argv: readonly string[]): ParseArgsResult => {
  let targetDir = '';
  let yes = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { kind: 'help', exitCode: 0, usage: USAGE };
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
    return {
      kind: 'error',
      exitCode: 1,
      usage: USAGE,
      message: `Unexpected argument: ${arg}`,
    };
  }

  if (!targetDir) {
    return { kind: 'help', exitCode: 1, usage: USAGE };
  }

  return { kind: 'ok', targetDir, opts: { yes, force } };
};
