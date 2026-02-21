#!/usr/bin/env node

import { runCli } from './cli/runCli.js';
import { errorFields, log } from './util/logger.js';

runCli().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.fatal('cli.crash', errorFields(err));
  process.stderr.write(`homie: ${msg}\n`);
  process.exit(1);
});
