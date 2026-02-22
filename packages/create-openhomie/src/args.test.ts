import { describe, expect, test } from 'bun:test';

import { parseArgs } from './args.js';

describe('create-openhomie parseArgs', () => {
  test('returns help on --help', () => {
    expect(parseArgs(['--help'])).toEqual(expect.objectContaining({ kind: 'help', exitCode: 0 }));
  });

  test('returns help when missing directory', () => {
    expect(parseArgs([])).toEqual(expect.objectContaining({ kind: 'help', exitCode: 1 }));
  });

  test('parses directory and flags', () => {
    expect(parseArgs(['mydir', '--yes', '--force'])).toEqual({
      kind: 'ok',
      targetDir: 'mydir',
      opts: { yes: true, force: true },
    });
  });

  test('rejects unexpected second positional', () => {
    const res = parseArgs(['a', 'b']);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toContain('Unexpected argument');
  });
});
