import { type LoadedHomieConfig, loadHomieConfig } from '../config/load.js';
import { runMain } from '../harness/harness.js';

import { parseCliArgs } from './args.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEvalCommand } from './commands/eval.js';
import { runExportCommand } from './commands/export.js';
import { runForgetCommand } from './commands/forget.js';
import { runInitCommand } from './commands/init.js';
import { runSelfImproveCommand } from './commands/self-improve.js';
import { runStatusCommand } from './commands/status.js';
import { runTrustCommand } from './commands/trust.js';
import { helpForCmd, trustHelp, USAGE } from './usage.js';

interface CliEnv extends NodeJS.ProcessEnv {
  HOMIE_CONFIG_PATH?: string;
}

export async function runCli(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const cmd = parsed.cmd;
  const cmdArgs = parsed.cmdArgs;
  const opts = parsed.opts;

  if (opts.help) {
    process.stdout.write(`${helpForCmd(cmd) ?? USAGE}\n`);
    process.exit(0);
  }

  const cliEnv = process.env as CliEnv;
  if (opts.configPath) cliEnv.HOMIE_CONFIG_PATH = opts.configPath;

  const loadCfg = async (): Promise<LoadedHomieConfig> => {
    return loadHomieConfig({
      cwd: process.cwd(),
      env: cliEnv,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
  };

  if (cmd === 'chat' || cmd === 'start' || cmd === 'consolidate') {
    await runMain(cmd, cmdArgs);
    return;
  }

  switch (cmd) {
    case 'init':
      await runInitCommand(opts);
      return;
    case 'eval':
      await runEvalCommand(opts, loadCfg);
      return;
    case 'status':
      await runStatusCommand(opts, loadCfg);
      return;
    case 'doctor':
      await runDoctorCommand(opts, loadCfg);
      return;
    case 'self-improve':
      await runSelfImproveCommand(opts, cmdArgs, loadCfg);
      return;
    case 'trust':
      await runTrustCommand(opts, cmdArgs, loadCfg, trustHelp);
      return;
    case 'export':
      await runExportCommand(loadCfg);
      return;
    case 'forget':
      await runForgetCommand(cmdArgs, loadCfg);
      return;
    default:
      process.stderr.write(`homie: unknown command "${cmd}"\n\n${USAGE}\n`);
      process.exit(1);
  }
}
