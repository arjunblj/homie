import { describe, expect, test } from 'bun:test';
import {
  parseJudgeModelArg,
  parseRequestedBackends,
  resolveBackendAvailability,
} from './eval-init.js';

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

  test('throws on unknown flag', () => {
    expect(() => parseRequestedBackends(['--bogus'])).toThrow('unknown option');
  });
});

describe('resolveBackendAvailability', () => {
  test('requires codex auth (not only CLI presence)', () => {
    const availability = resolveBackendAvailability({
      hasClaudeCodeCli: true,
      hasClaudeAuth: false,
      hasCodexAuth: false,
    });
    expect(availability['codex-cli']).toBe(false);
    expect(availability['claude-code']).toBe(false);
  });

  test('marks codex-cli available when authenticated', () => {
    const availability = resolveBackendAvailability({
      hasClaudeCodeCli: true,
      hasClaudeAuth: true,
      hasCodexAuth: true,
    });
    expect(availability['claude-code']).toBe(true);
    expect(availability['codex-cli']).toBe(true);
  });
});
