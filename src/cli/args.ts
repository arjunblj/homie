export type GlobalOpts = {
  help: boolean;
  json: boolean;
  force: boolean;
  interactive: boolean;
  yes: boolean;
  verifyMpp: boolean;
  verbose: boolean;
  quiet: boolean;
  noColor: boolean;
  configPath?: string | undefined;
};

const COMMANDS_WITHOUT_POSITIONAL_ARGS = new Set(['init', 'status', 'doctor', 'export']);

export const parseCliArgs = (
  argv: readonly string[],
): { cmd: string; cmdArgs: string[]; opts: GlobalOpts } => {
  const remaining: string[] = [];
  const opts: GlobalOpts = {
    help: false,
    json: false,
    force: false,
    interactive: true,
    yes: false,
    verifyMpp: false,
    verbose: false,
    quiet: false,
    noColor: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '--force') {
      opts.force = true;
      continue;
    }
    if (a === '--yes' || a === '-y') {
      opts.yes = true;
      opts.interactive = false;
      continue;
    }
    if (a === '--verify-mpp') {
      opts.verifyMpp = true;
      continue;
    }
    if (a === '--verbose' || a === '-v') {
      opts.verbose = true;
      continue;
    }
    if (a === '--quiet' || a === '-q') {
      opts.quiet = true;
      continue;
    }
    if (a === '--no-color') {
      opts.noColor = true;
      continue;
    }
    if (a === '--no-interactive' || a === '--non-interactive') {
      opts.interactive = false;
      continue;
    }
    if (a === '--config') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) throw new Error('--config requires a path');
      const value = next.trim();
      if (!value) throw new Error('--config requires a path');
      opts.configPath = value;
      i += 1;
      continue;
    }
    if (a.startsWith('--config=')) {
      const value = a.slice('--config='.length).trim();
      if (!value) throw new Error('--config requires a path');
      opts.configPath = value;
      continue;
    }
    if (a === '--') {
      remaining.push(...argv.slice(i + 1));
      break;
    }
    if (remaining.length === 0 && a.startsWith('--')) {
      throw new Error(`unknown option "${a}". Run homie --help for usage.`);
    }
    remaining.push(a);
  }

  const cmd = remaining[0] ?? 'chat';
  const cmdArgs = remaining.slice(1);
  if (COMMANDS_WITHOUT_POSITIONAL_ARGS.has(cmd) && cmdArgs.length > 0) {
    const first = cmdArgs[0];
    if (first?.startsWith('-')) {
      throw new Error(`unknown option "${first}". Run homie ${cmd} --help for usage.`);
    }
    throw new Error(`unexpected argument "${first}". Run homie ${cmd} --help for usage.`);
  }
  return { cmd, cmdArgs, opts };
};
