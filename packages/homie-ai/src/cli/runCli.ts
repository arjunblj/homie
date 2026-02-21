import { type LoadedHomieConfig, loadHomieConfig } from '../config/load.js';

import { parseCliArgs } from './args.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEvalCommand } from './commands/eval.js';
import { runEvalInitCommand } from './commands/eval-init.js';
import { runExportCommand } from './commands/export.js';
import { runForgetCommand } from './commands/forget.js';
import { runInitCommand } from './commands/init.js';
import { runSelfImproveCommand } from './commands/self-improve.js';
import { runStatusCommand } from './commands/status.js';
import { runTrustCommand } from './commands/trust.js';
import { helpForCmd, renderUsage, trustHelp } from './usage.js';

const formatCliError = (message: string): string =>
  message.startsWith('homie:') ? message : `homie: ${message}`;

export async function runCli(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${formatCliError(msg)}\n`);
    process.exit(1);
  }

  const cmd = parsed.cmd;
  const cmdArgs = parsed.cmdArgs;
  const opts = parsed.opts;

  if (opts.help) {
    process.stdout.write(`${helpForCmd(cmd, opts.noColor) ?? renderUsage(opts.noColor)}\n`);
    process.exit(0);
  }

  const loadCfg = async (): Promise<LoadedHomieConfig> => {
    return loadHomieConfig({
      cwd: process.cwd(),
      env: process.env,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
  };

  try {
    if (cmd === 'chat' || cmd === 'start' || cmd === 'consolidate') {
      const { runMain } = await import('../harness/harness.js');
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
      case 'eval-init':
        await runEvalInitCommand(opts, cmdArgs);
        return;
      case 'status':
        await runStatusCommand(opts, loadCfg);
        return;
      case 'doctor':
        await runDoctorCommand(opts, loadCfg);
        return;
      case 'deploy':
        // Lazy import keeps startup fast for non-deploy commands.
        {
          const { runDeployCommand } = await import('./commands/deploy.js');
          await runDeployCommand(opts, cmdArgs, loadCfg);
        }
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
        process.stderr.write(`homie: unknown command "${cmd}"\n\n${renderUsage(opts.noColor)}\n`);
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${formatCliError(msg)}\n`);
    process.exit(1);
  }
}
