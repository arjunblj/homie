export type GlobalOpts = {
  help: boolean;
  json: boolean;
  force: boolean;
  interactive: boolean;
  configPath?: string | undefined;
};

export const parseCliArgs = (
  argv: readonly string[],
): { cmd: string; cmdArgs: string[]; opts: GlobalOpts } => {
  const remaining: string[] = [];
  const opts: GlobalOpts = { help: false, json: false, force: false, interactive: true };

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
    if (a === '--no-interactive' || a === '--non-interactive') {
      opts.interactive = false;
      continue;
    }
    if (a === '--config') {
      const next = argv[i + 1];
      if (!next) throw new Error('homie: --config requires a path');
      opts.configPath = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--config=')) {
      opts.configPath = a.slice('--config='.length).trim();
      continue;
    }
    remaining.push(a);
  }

  const cmd = remaining[0] ?? 'chat';
  const cmdArgs = remaining.slice(1);
  return { cmd, cmdArgs, opts };
};
