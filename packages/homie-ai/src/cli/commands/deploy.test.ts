import { describe, expect, test } from 'bun:test';
import { parseDeployArgs } from './deploy.js';

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
