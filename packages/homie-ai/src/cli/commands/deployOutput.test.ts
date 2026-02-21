import { describe, expect, test } from 'bun:test';
import { resolveDeployOutputMode } from './deployOutput.js';

describe('resolveDeployOutputMode', () => {
  test('prefers json mode', () => {
    expect(resolveDeployOutputMode({ json: true, verbose: true, quiet: true })).toBe('json');
  });

  test('uses quiet when requested', () => {
    expect(resolveDeployOutputMode({ json: false, verbose: false, quiet: true })).toBe('quiet');
  });

  test('uses verbose when requested', () => {
    expect(resolveDeployOutputMode({ json: false, verbose: true, quiet: false })).toBe('verbose');
  });

  test('defaults to standard mode', () => {
    expect(resolveDeployOutputMode({ json: false, verbose: false, quiet: false })).toBe('default');
  });
});
