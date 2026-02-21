import { describe, expect, test } from 'bun:test';
import { normalizeDropletName, parseDeployArgs, sanitizeDeployErrorMessage } from './deploy.js';

describe('parseDeployArgs', () => {
  test('defaults to apply action', () => {
    const parsed = parseDeployArgs([]);
    expect(parsed.action).toBe('apply');
    expect(parsed.dryRun).toBeFalse();
  });

  test('parses status subcommand', () => {
    const parsed = parseDeployArgs(['status']);
    expect(parsed.action).toBe('status');
  });

  test('parses deploy flags', () => {
    const parsed = parseDeployArgs([
      '--dry-run',
      '--region=lon1',
      '--size=s-2vcpu-2gb',
      '--image=ubuntu-24-04-x64',
      '--name=my-homie',
    ]);
    expect(parsed.action).toBe('apply');
    expect(parsed.dryRun).toBeTrue();
    expect(parsed.region).toBe('lon1');
    expect(parsed.size).toBe('s-2vcpu-2gb');
    expect(parsed.image).toBe('ubuntu-24-04-x64');
    expect(parsed.name).toBe('my-homie');
  });

  test('throws for unknown subcommand', () => {
    expect(() => parseDeployArgs(['launch'])).toThrow('unknown subcommand');
  });

  test('throws for unknown flag', () => {
    expect(() => parseDeployArgs(['--bogus'])).toThrow('unknown option');
  });
});

describe('sanitizeDeployErrorMessage', () => {
  test('redacts common secret-looking fragments', () => {
    const privateKey = `0x${'a'.repeat(64)}`;
    const raw = `deploy failed token=abc123 api_key:shhh MPP_PRIVATE_KEY=${privateKey}`;
    const sanitized = sanitizeDeployErrorMessage(raw);
    expect(sanitized).toContain('token=[redacted]');
    expect(sanitized).toContain('api_key=[redacted]');
    expect(sanitized).toContain('MPP_PRIVATE_KEY=[redacted]');
    expect(sanitized).not.toContain(privateKey);
  });

  test('redacts quoted and spaced secret assignments', () => {
    const raw = `token = "abc def"\napi-key : 'secret value'`;
    const sanitized = sanitizeDeployErrorMessage(raw);
    expect(sanitized).toContain('token=[redacted]');
    expect(sanitized).toContain('api-key=[redacted]');
    expect(sanitized).not.toContain('abc def');
    expect(sanitized).not.toContain('secret value');
  });

  test('caps output length to keep state/log payloads compact', () => {
    const longText = `error: ${'x'.repeat(800)}`;
    const sanitized = sanitizeDeployErrorMessage(longText);
    expect(sanitized.length).toBeLessThanOrEqual(421);
  });
});

describe('normalizeDropletName', () => {
  test('normalizes casing and disallowed characters', () => {
    expect(normalizeDropletName(' My_Proj.Name ')).toBe('my-proj-name');
  });

  test('truncates to 63 chars and strips trailing hyphen', () => {
    const source = `my-${'x'.repeat(80)}---`;
    const normalized = normalizeDropletName(source);
    expect(normalized.length).toBeLessThanOrEqual(63);
    expect(normalized.endsWith('-')).toBeFalse();
  });

  test('rejects empty names after normalization', () => {
    expect(() => normalizeDropletName('---')).toThrow('cannot be empty after normalization');
  });
});
