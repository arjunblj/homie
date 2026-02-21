import { describe, expect, test } from 'bun:test';

import { detectTerminalCapabilities } from './terminalCapabilities.js';

describe('detectTerminalCapabilities', () => {
  test('returns an object with expected shape', () => {
    const caps = detectTerminalCapabilities({});
    expect(caps).toHaveProperty('supportsUnicode');
    expect(caps).toHaveProperty('supportsSynchronizedOutput');
    expect(caps).toHaveProperty('recommendedDeltaBatchMs');
    expect(typeof caps.supportsUnicode).toBe('boolean');
    expect(typeof caps.supportsSynchronizedOutput).toBe('boolean');
    expect(typeof caps.recommendedDeltaBatchMs).toBe('number');
  });

  test('detects iTerm as supporting synchronized output', () => {
    const caps = detectTerminalCapabilities({ TERM_PROGRAM: 'iTerm.app' });
    expect(caps.supportsSynchronizedOutput).toBe(true);
    expect(caps.recommendedDeltaBatchMs).toBe(18);
  });

  test('detects WezTerm as supporting synchronized output', () => {
    const caps = detectTerminalCapabilities({ TERM_PROGRAM: 'WezTerm' });
    expect(caps.supportsSynchronizedOutput).toBe(true);
  });

  test('detects kitty via TERM', () => {
    const caps = detectTerminalCapabilities({ TERM: 'xterm-kitty' });
    expect(caps.supportsSynchronizedOutput).toBe(true);
  });

  test('detects ghostty via TERM', () => {
    const caps = detectTerminalCapabilities({ TERM: 'ghostty' });
    expect(caps.supportsSynchronizedOutput).toBe(true);
  });

  test('basic terminal falls back to no sync output', () => {
    const caps = detectTerminalCapabilities({ TERM: 'xterm-256color' });
    expect(caps.supportsSynchronizedOutput).toBe(false);
    expect(caps.recommendedDeltaBatchMs).toBe(28);
  });

  test('detects unicode support from LANG', () => {
    const caps = detectTerminalCapabilities({ LANG: 'en_US.UTF-8' });
    expect(caps.supportsUnicode).toBe(true);
  });

  test('detects unicode from LC_ALL', () => {
    const caps = detectTerminalCapabilities({ LC_ALL: 'C.utf8' });
    expect(caps.supportsUnicode).toBe(true);
  });

  test('no unicode when locale vars are absent', () => {
    const caps = detectTerminalCapabilities({});
    expect(caps.supportsUnicode).toBe(false);
  });
});
