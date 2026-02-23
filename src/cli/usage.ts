import { stripVTControlCharacters } from 'node:util';
import gradient from 'gradient-string';
import pc from 'picocolors';
import terminalLink from 'terminal-link';

const brand = gradient(['#7c3aed', '#2563eb', '#06b6d4']);

const cmd = (name: string, desc: string, hint?: string): string => {
  const h = hint ? pc.dim(` ${hint}`) : '';
  return `  ${pc.bold(pc.cyan(name))}${' '.repeat(Math.max(1, 22 - name.length))}${desc}${h}`;
};

const opt = (flag: string, desc: string): string =>
  `  ${pc.yellow(flag)}${' '.repeat(Math.max(1, 22 - flag.length))}${pc.dim(desc)}`;

const section = (title: string): string => `\n${pc.bold(title)}`;

const docsUrl = terminalLink('docs', 'https://github.com/arjunblj/openhomie', {
  fallback: (_, url) => url,
});

const USAGE: string = [
  '',
  `  ${brand('homie')} ${pc.dim('— open-source runtime for AI friends')}`,
  '',
  section('Commands'),
  cmd('init', 'Create homie.toml + identity', 'wizard'),
  cmd('chat', 'CLI operator view', 'debug, traces, control'),
  cmd('start', 'Launch your friend', 'Signal, Telegram'),
  cmd('eval', 'Run friend eval cases'),
  cmd('eval-init', 'Test init quality across backends'),
  cmd('consolidate', 'Run memory consolidation once'),
  cmd('gap-analysis', 'Finalize feedback + synthesize gap analysis'),
  cmd('self-improve', 'Autonomous improvement queue', 'plan|run|status'),
  cmd('status', 'Config, model, and runtime stats', '--json'),
  cmd('doctor', 'Check config and dependencies', '--json'),
  cmd('deploy', 'Provision + manage VPS via MPP', 'apply|status|resume|ssh|destroy'),
  cmd('trust', 'Manage trust overrides', 'list|set|clear'),
  cmd('export', 'Export memory as JSON'),
  cmd('forget <id>', 'Forget a person'),
  '',
  section('Global options'),
  opt('--config <path>', 'Use a specific homie.toml'),
  opt('--json', 'JSON output (status/doctor/deploy)'),
  opt('--force', 'Overwrite existing files (init)'),
  opt('--yes, -y', 'Accept defaults, skip prompts'),
  opt('--verify-mpp', 'Verify MPP wallet via model call (doctor)'),
  opt('--verbose, -v', 'Detailed logs'),
  opt('--quiet, -q', 'Minimal output'),
  opt('--no-color', 'Disable ANSI colors'),
  opt('--help, -h', 'Show help'),
  '',
  section('Command options'),
  `  ${pc.dim('Use `homie <command> --help` for command-specific flags.')}`,
  '',
  section('Providers'),
  `  ${pc.green('✓')} Claude Code CLI    ${pc.green('✓')} Codex CLI       ${pc.green('✓')} OpenRouter`,
  `  ${pc.green('✓')} Anthropic API      ${pc.green('✓')} OpenAI          ${pc.green('✓')} Ollama`,
  `  ${pc.green('✓')} MPP stablecoins`,
  '',
  `  ${pc.dim('Docs')} ${docsUrl}`,
  '',
].join('\n');

const HELP_BY_CMD = {
  status: [
    `${pc.bold('homie status')}`,
    '',
    opt('--json', 'JSON output'),
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  doctor: [
    `${pc.bold('homie doctor')}`,
    '',
    opt('--json', 'JSON output'),
    opt('--verify-mpp', 'Run a paid model-level MPP verification'),
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  deploy: [
    `${pc.bold('homie deploy')} ${pc.dim('[apply|status|resume|ssh|destroy]')}`,
    '',
    opt('--dry-run', 'Preview actions without mutating infrastructure'),
    opt('--region=<slug>', 'Override region (default nyc3)'),
    opt('--size=<slug>', 'Override size (default s-1vcpu-1gb)'),
    opt('--image=<slug>', 'Override image (default ubuntu-24-04-x64)'),
    opt('--name=<value>', 'Override droplet name'),
    opt('--json', 'NDJSON events / machine output'),
    opt('--verbose, -v', 'Detailed logs'),
    opt('--quiet, -q', 'Minimal output'),
    opt('--yes, -y', 'Non-interactive defaults'),
  ].join('\n'),

  init: [
    `${pc.bold('homie init')}`,
    '',
    opt('--config PATH', 'Write homie.toml to this path'),
    opt('--force', 'Overwrite existing files'),
    opt('--yes, -y', 'Accept defaults, skip prompts'),
  ].join('\n'),

  eval: [
    `${pc.bold('homie eval')}`,
    '',
    opt('--json', 'JSON output'),
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  'eval-init': [
    `${pc.bold('homie eval-init')} ${pc.dim('[backends...]')}`,
    '',
    pc.dim('  Test init interview quality across CLI backends.'),
    pc.dim('  Requires OPENROUTER_API_KEY for LLM-as-judge scoring.'),
    '',
    `  Backends: ${pc.cyan('claude-code')}, ${pc.cyan('codex-cli')}`,
    `  Omit to auto-detect available CLIs.`,
    '',
    opt('--judge-model=MODEL', 'OpenRouter model for judging'),
    opt('--json', 'JSON output'),
  ].join('\n'),

  'gap-analysis': [
    `${pc.bold('homie gap-analysis')}`,
    '',
    opt('--dry-run', 'Print planned finalizations (default)'),
    opt('--apply', 'Apply and synthesize lessons'),
    opt('--limit N', 'Limit dry-run output (default 25)'),
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  'self-improve': [
    `${pc.bold('homie self-improve')} ${pc.dim('[plan|run|status]')}`,
    '',
    pc.dim('  Turns behavioral_feedback lessons into a durable queue of engineering tasks.'),
    pc.dim('  By default this is dry-run; use --apply to enqueue or to run an item.'),
    '',
    opt('--dry-run', 'Preview output (default)'),
    opt('--apply', 'Enqueue/run (mutates queue; run may open PRs)'),
    opt('--limit N', 'Max items to plan (default 5)'),
    opt('--min-confidence X', 'Min confidence to auto-run (default 0.55)'),
    opt('--no-pr', 'Do not open a PR (still pushes branch)'),
    opt('--allow-md', 'Allow .md file changes (default false)'),
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  trust: [
    `${pc.bold('homie trust')}`,
    '',
    `  ${pc.cyan('homie trust list')}`,
    `  ${pc.cyan('homie trust set')} ${pc.dim('<userId> <tier>')}`,
    `  ${pc.cyan('homie trust clear')} ${pc.dim('<userId>')}`,
    '',
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  export: [
    `${pc.bold('homie export')}`,
    '',
    pc.dim('  Export memory store as JSON to stdout.'),
    '',
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  forget: [
    `${pc.bold('homie forget')} ${pc.dim('<personId>')}`,
    '',
    pc.dim('  Remove a person and their episodes from memory.'),
    '',
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),

  consolidate: [
    `${pc.bold('homie consolidate')}`,
    '',
    pc.dim('  Run a single memory consolidation pass.'),
    '',
    opt('--config PATH', 'Use a specific homie.toml'),
  ].join('\n'),
} as const;

const maybeStripColor = (value: string, noColor: boolean): string => {
  if (!noColor) return value;
  return stripVTControlCharacters(value);
};

export const renderUsage = (noColor = false): string => maybeStripColor(USAGE, noColor);

export const helpForCmd = (cmd: string, noColor = false): string | undefined => {
  if (Object.hasOwn(HELP_BY_CMD, cmd)) {
    return maybeStripColor(HELP_BY_CMD[cmd as keyof typeof HELP_BY_CMD], noColor);
  }
  return undefined;
};

export const trustHelp = (): string => HELP_BY_CMD.trust;
