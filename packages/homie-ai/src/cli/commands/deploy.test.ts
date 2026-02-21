import { describe, expect, test } from 'bun:test';
import { MppDoError } from '../../infra/mppDo.js';
import {
  isDropletAlreadyDeletedError,
  normalizeDropletName,
  parseDeployArgs,
  sanitizeDeployErrorMessage,
  shouldRunDeployInteractively,
  toDeployCliError,
} from './deploy.js';

describe('parseDeployArgs', () => {
  test('defaults to apply action', () => {
    const parsed = parseDeployArgs([]);
    expect(parsed.action).toBe('apply');
    expect(parsed.dryRun).toBeFalse();
  });

  test('parses explicit apply subcommand', () => {
    const parsed = parseDeployArgs(['apply', '--dry-run']);
    expect(parsed.action).toBe('apply');
    expect(parsed.dryRun).toBeTrue();
  });

  test('parses status subcommand', () => {
    const parsed = parseDeployArgs(['status']);
    expect(parsed.action).toBe('status');
  });

  test('parses resume subcommand', () => {
    const parsed = parseDeployArgs(['resume']);
    expect(parsed.action).toBe('resume');
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

  test('rejects apply-only flags for non-apply subcommands', () => {
    expect(() => parseDeployArgs(['status', '--dry-run'])).toThrow('only valid for apply');
    expect(() => parseDeployArgs(['resume', '--region=nyc3'])).toThrow('only valid for apply');
  });
});

describe('shouldRunDeployInteractively', () => {
  test('returns false in json mode', () => {
    expect(
      shouldRunDeployInteractively({
        interactive: true,
        yes: false,
        json: true,
      }),
    ).toBeFalse();
  });

  test('returns false when auto-confirm yes is set', () => {
    expect(
      shouldRunDeployInteractively({
        interactive: true,
        yes: true,
        json: false,
      }),
    ).toBeFalse();
  });

  test('returns true only for explicit interactive non-json flow', () => {
    expect(
      shouldRunDeployInteractively({
        interactive: true,
        yes: false,
        json: false,
      }),
    ).toBeTrue();
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

describe('toDeployCliError', () => {
  test('returns sanitized error text only', () => {
    const privateKey = `0x${'b'.repeat(64)}`;
    const cliError = toDeployCliError(
      new Error(`deploy failed MPP_PRIVATE_KEY=${privateKey} token=abc123`),
    );
    expect(cliError.message).toContain('MPP_PRIVATE_KEY=[redacted]');
    expect(cliError.message).toContain('token=[redacted]');
    expect(cliError.message).not.toContain(privateKey);
    expect(cliError.message).not.toContain('abc123');
  });
});

describe('isDropletAlreadyDeletedError', () => {
  test('returns true for not_found mpp droplet errors', () => {
    expect(isDropletAlreadyDeletedError(new MppDoError('not_found', 'missing'))).toBeTrue();
  });

  test('returns false for other errors', () => {
    expect(isDropletAlreadyDeletedError(new MppDoError('timeout', 'timed out'))).toBeFalse();
    expect(isDropletAlreadyDeletedError(new Error('missing'))).toBeFalse();
  });
});
