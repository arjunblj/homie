import { describe, expect, test } from 'bun:test';
import { parseSelfImproveArgs } from './self-improve.js';

describe('parseSelfImproveArgs', () => {
  test('uses dry-run defaults', () => {
    expect(parseSelfImproveArgs([])).toEqual({ apply: false, limit: 25 });
  });

  test('parses --apply and --limit forms', () => {
    expect(parseSelfImproveArgs(['--apply', '--limit', '10'])).toEqual({
      apply: true,
      limit: 10,
    });
    expect(parseSelfImproveArgs(['--limit=12'])).toEqual({ apply: false, limit: 12 });
  });

  test('last mode flag wins between --apply and --dry-run', () => {
    expect(parseSelfImproveArgs(['--apply', '--dry-run'])).toEqual({ apply: false, limit: 25 });
  });

  test('throws for missing --limit value', () => {
    expect(() => parseSelfImproveArgs(['--limit'])).toThrow('--limit requires a value');
    expect(() => parseSelfImproveArgs(['--limit', '--apply'])).toThrow('--limit requires a value');
    expect(() => parseSelfImproveArgs(['--limit='])).toThrow('--limit requires a value');
  });

  test('throws for invalid --limit value', () => {
    expect(() => parseSelfImproveArgs(['--limit=abc'])).toThrow(
      '--limit must be a positive integer',
    );
    expect(() => parseSelfImproveArgs(['--limit=0'])).toThrow('--limit must be a positive integer');
    expect(() => parseSelfImproveArgs(['--limit=-2'])).toThrow(
      '--limit must be a positive integer',
    );
  });
});
