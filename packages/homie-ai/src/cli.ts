#!/usr/bin/env node

const USAGE: string = `homie

Usage:
  homie --help
`;

const args: string[] = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

process.stderr.write('homie: not implemented yet (scaffold)\n');
process.exit(1);
