export const USAGE: string = `homie — open-source runtime for AI friends

Usage:
  homie init                Create homie.toml + identity skeleton in cwd
  homie chat                Interactive CLI chat (operator mode)
  homie start               Start all configured channels (Signal, Telegram)
  homie eval                Run friend eval cases with current model
  homie consolidate         Run memory consolidation once
  homie self-improve        Finalize feedback + synthesize lessons (ops-plane)
  homie status [--json]     Show config, model, and runtime stats
  homie doctor [--json]     Check config, env vars, identity, and SQLite stores
  homie trust ...           Manage trust overrides for people (operator)
  homie export              Export memory as JSON to stdout
  homie forget <id>         Forget a person (delete person + facts, keep episodes)
  homie --help       Show this help

Global options:
  --config <path>    Use a specific homie.toml (default: search up from cwd)
  --json             JSON output (status/doctor only)
  --force            Overwrite existing files (init only)

Environment:
  ANTHROPIC_API_KEY         Anthropic API key (recommended)
  OPENROUTER_API_KEY        OpenRouter key (if using OpenRouter)
  SIGNAL_API_URL            Signal CLI REST API base URL (signal-cli-rest-api)
  SIGNAL_DAEMON_URL         signal-cli daemon base URL (HTTP JSON-RPC + SSE)
  SIGNAL_NUMBER             Your Signal phone number
  SIGNAL_OPERATOR_NUMBER    Operator's Signal number (optional)
  TELEGRAM_BOT_TOKEN        Telegram bot token
  TELEGRAM_OPERATOR_USER_ID Operator's Telegram user ID (optional)
  BRAVE_API_KEY             Brave Search API key (optional)
`;

const HELP_BY_CMD = {
  status: `homie status\n\nOptions:\n  --json        JSON output\n  --config PATH Use a specific homie.toml\n`,
  doctor: `homie doctor\n\nOptions:\n  --json        JSON output\n  --config PATH Use a specific homie.toml\n`,
  init: `homie init\n\nOptions:\n  --config PATH        Write homie.toml to this path\n  --force              Overwrite existing files\n  --no-interactive     Disable prompts (auto-detect defaults)\n`,
  eval: `homie eval\n\nOptions:\n  --json        JSON output\n  --config PATH Use a specific homie.toml\n`,
  'self-improve': `homie self-improve\n\nOptions:\n  --dry-run           Print planned finalizations (default)\n  --apply             Apply finalizations and synthesize lessons\n  --limit N           Limit dry-run output (default 25)\n  --config PATH       Use a specific homie.toml\n`,
  trust:
    `homie trust\n\n` +
    `Subcommands:\n` +
    `  homie trust list\n` +
    `  homie trust set <channelUserId> <new_contact|getting_to_know|close_friend>\n` +
    `  homie trust clear <channelUserId>\n` +
    `\nOptions:\n  --config PATH Use a specific homie.toml\n`,
} as const;

export const helpForCmd = (cmd: string): string | undefined => {
  if (Object.hasOwn(HELP_BY_CMD, cmd)) {
    return HELP_BY_CMD[cmd as keyof typeof HELP_BY_CMD];
  }
  return undefined;
};

export const trustHelp = (): string => HELP_BY_CMD.trust;
