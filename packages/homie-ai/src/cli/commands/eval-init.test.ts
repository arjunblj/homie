import { describe, expect, test } from 'bun:test';
import { parseJudgeModelArg, parseRequestedBackends } from './eval-init.js';

describe('parseJudgeModelArg', () => {
  test('uses default model when flag is omitted', () => {
    expect(parseJudgeModelArg([])).toBe('anthropic/claude-sonnet-4-5');
  });

  test('parses --judge-model forms', () => {
    expect(parseJudgeModelArg(['--judge-model=openai/gpt-4o'])).toBe('openai/gpt-4o');
    expect(parseJudgeModelArg(['--judge-model', 'openai/gpt-4o-mini'])).toBe('openai/gpt-4o-mini');
  });

  test('throws for empty judge model', () => {
    expect(() => parseJudgeModelArg(['--judge-model='])).toThrow(
      '--judge-model requires a non-empty value',
    );
    expect(() => parseJudgeModelArg(['--judge-model'])).toThrow(
      '--judge-model requires a non-empty value',
    );
    expect(() => parseJudgeModelArg(['--judge-model', '--json'])).toThrow(
      '--judge-model requires a non-empty value',
    );
  });
});

describe('parseRequestedBackends', () => {
  test('returns explicit backend list', () => {
    expect(parseRequestedBackends(['claude-code', 'codex-cli'])).toEqual([
      'claude-code',
      'codex-cli',
    ]);
  });

  test('ignores judge-model flags and values', () => {
    expect(parseRequestedBackends(['--judge-model', 'openai/gpt-4o', 'claude-code'])).toEqual([
      'claude-code',
    ]);
    expect(parseRequestedBackends(['--judge-model=openai/gpt-4o-mini', 'codex-cli'])).toEqual([
      'codex-cli',
    ]);
  });

  test('throws on unknown backend token', () => {
    expect(() => parseRequestedBackends(['claud-code'])).toThrow('unknown backend');
  });
});
