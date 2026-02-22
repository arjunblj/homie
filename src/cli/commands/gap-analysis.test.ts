import { describe, expect, test } from 'bun:test';
import { parseGapAnalysisArgs } from './gap-analysis.js';

describe('parseGapAnalysisArgs', () => {
  test('uses dry-run defaults', () => {
    expect(parseGapAnalysisArgs([])).toEqual({ apply: false, limit: 25 });
  });

  test('parses --apply and --limit forms', () => {
    expect(parseGapAnalysisArgs(['--apply', '--limit', '10'])).toEqual({
      apply: true,
      limit: 10,
    });
    expect(parseGapAnalysisArgs(['--limit=12'])).toEqual({ apply: false, limit: 12 });
  });

  test('last mode flag wins between --apply and --dry-run', () => {
    expect(parseGapAnalysisArgs(['--apply', '--dry-run'])).toEqual({ apply: false, limit: 25 });
  });

  test('throws for missing --limit value', () => {
    expect(() => parseGapAnalysisArgs(['--limit'])).toThrow(
      'homie gap-analysis: --limit requires a value',
    );
    expect(() => parseGapAnalysisArgs(['--limit', '--apply'])).toThrow(
      'homie gap-analysis: --limit requires a value',
    );
    expect(() => parseGapAnalysisArgs(['--limit='])).toThrow(
      'homie gap-analysis: --limit requires a value',
    );
  });

  test('throws for invalid --limit value', () => {
    expect(() => parseGapAnalysisArgs(['--limit=abc'])).toThrow(
      'homie gap-analysis: --limit must be a positive integer',
    );
    expect(() => parseGapAnalysisArgs(['--limit=0'])).toThrow(
      'homie gap-analysis: --limit must be a positive integer',
    );
    expect(() => parseGapAnalysisArgs(['--limit=-2'])).toThrow(
      'homie gap-analysis: --limit must be a positive integer',
    );
  });
});
