import { describe, expect, test } from 'bun:test';
import { parseCliArgs } from './args.js';

describe('parseCliArgs', () => {
  test('defaults to chat command with interactive mode', () => {
    const parsed = parseCliArgs([]);
    expect(parsed.cmd).toBe('chat');
    expect(parsed.cmdArgs).toEqual([]);
    expect(parsed.opts.interactive).toBeTrue();
    expect(parsed.opts.verifyMpp).toBeFalse();
  });

  test('parses core global flags', () => {
    const parsed = parseCliArgs(['doctor', '--verify-mpp', '--json', '--force', '--help']);
    expect(parsed.cmd).toBe('doctor');
    expect(parsed.opts.verifyMpp).toBeTrue();
    expect(parsed.opts.json).toBeTrue();
    expect(parsed.opts.force).toBeTrue();
    expect(parsed.opts.help).toBeTrue();
  });

  test('parses yes flag and disables interactive mode', () => {
    const parsed = parseCliArgs(['init', '--yes']);
    expect(parsed.cmd).toBe('init');
    expect(parsed.opts.yes).toBeTrue();
    expect(parsed.opts.interactive).toBeFalse();
  });

  test('parses no-interactive aliases', () => {
    expect(parseCliArgs(['chat', '--no-interactive']).opts.interactive).toBeFalse();
    expect(parseCliArgs(['chat', '--non-interactive']).opts.interactive).toBeFalse();
  });

  test('parses --config with separate value', () => {
    const parsed = parseCliArgs(['init', '--config', './homie.toml']);
    expect(parsed.opts.configPath).toBe('./homie.toml');
  });

  test('parses --config=<path>', () => {
    const parsed = parseCliArgs(['init', '--config=./custom.toml']);
    expect(parsed.opts.configPath).toBe('./custom.toml');
  });

  test('throws when --config has no value', () => {
    expect(() => parseCliArgs(['init', '--config'])).toThrow('requires a path');
    expect(() => parseCliArgs(['init', '--config', '--json'])).toThrow('requires a path');
    expect(() => parseCliArgs(['init', '--config='])).toThrow('requires a path');
  });

  test('retains command args after command token', () => {
    const parsed = parseCliArgs(['eval', '--input', 'fixtures/demo.json']);
    expect(parsed.cmd).toBe('eval');
    expect(parsed.cmdArgs).toEqual(['--input', 'fixtures/demo.json']);
  });

  test('keeps eval-init judge flags as command args', () => {
    const parsed = parseCliArgs(['eval-init', '--judge-model=openai/gpt-4o-mini']);
    expect(parsed.cmd).toBe('eval-init');
    expect(parsed.cmdArgs).toEqual(['--judge-model=openai/gpt-4o-mini']);
  });

  test('keeps self-improve mode/limit flags as command args', () => {
    const parsed = parseCliArgs(['self-improve', '--apply', '--limit', '5']);
    expect(parsed.cmd).toBe('self-improve');
    expect(parsed.cmdArgs).toEqual(['--apply', '--limit', '5']);
  });

  test('rejects unknown flags before command token', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow('unknown option');
    expect(() => parseCliArgs(['--typo', 'chat'])).toThrow('unknown option');
  });

  test('-- separator passes remaining args as cmdArgs', () => {
    const parsed = parseCliArgs(['eval', '--', '--weird', 'stuff']);
    expect(parsed.cmd).toBe('eval');
    expect(parsed.cmdArgs).toEqual(['--weird', 'stuff']);
  });

  test('-y is an alias for --yes', () => {
    const parsed = parseCliArgs(['init', '-y']);
    expect(parsed.opts.yes).toBeTrue();
    expect(parsed.opts.interactive).toBeFalse();
  });
});
