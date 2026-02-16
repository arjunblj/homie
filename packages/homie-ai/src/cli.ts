#!/usr/bin/env node

import { AgentRuntime } from './agent/runtime.js';
import { runCliChat } from './channels/cli.js';
import { loadHomieConfig } from './config/load.js';
import { createProviderRegistry } from './llm/registry.js';
import { createToolRegistry, getToolsForTier } from './tools/registry.js';

const USAGE: string = `homie

Usage:
  homie chat        Start interactive CLI chat
  homie --help

Notes:
  - Requires a homie.toml (auto-discovered) and model API key(s).
`;

const args: string[] = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const cmd = args[0] ?? 'chat';
if (cmd !== 'chat') {
  process.stderr.write(`homie: unknown command "${cmd}"\n\n${USAGE}\n`);
  process.exit(1);
}

const main = async (): Promise<void> => {
  const loaded = await loadHomieConfig({ cwd: process.cwd(), env: process.env });
  const providers = await createProviderRegistry({ config: loaded.config, env: process.env });

  const toolReg = createToolRegistry();
  const tools = getToolsForTier(toolReg, ['safe']);

  const runtime = new AgentRuntime({
    config: loaded.config,
    providers,
    tools,
  });

  await runCliChat({ config: loaded.config, runtime });
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`homie: ${msg}\n`);
  process.exit(1);
});
