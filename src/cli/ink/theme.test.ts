import { describe, expect, test } from 'bun:test';

import { friendlyPhase, friendlyToolLabel } from './theme.js';

describe('friendlyPhase', () => {
  test('returns "thinking" for short elapsed times', () => {
    expect(friendlyPhase('thinking', 1000)).toBe('thinking');
  });

  test('returns "still thinking" after 8 seconds', () => {
    expect(friendlyPhase('thinking', 9000)).toBe('still thinking');
  });

  test('returns "waiting for backend" after 15 seconds', () => {
    expect(friendlyPhase('thinking', 16_000)).toBe('waiting for backend');
  });

  test('returns slow warning after 30 seconds', () => {
    expect(friendlyPhase('thinking', 31_000)).toContain('slower than usual');
  });

  test('returns "responding" for streaming phase', () => {
    expect(friendlyPhase('streaming', 500)).toBe('responding');
  });

  test('returns friendly tool label for tool_use with tool name', () => {
    expect(friendlyPhase('tool_use', 500, 'search_web')).toBe('searching the web');
  });

  test('falls back to thinking when tool_use has no tool name', () => {
    expect(friendlyPhase('tool_use', 500)).toBe('thinking');
  });
});

describe('friendlyToolLabel', () => {
  test('maps known tool names to friendly labels', () => {
    expect(friendlyToolLabel('search_web')).toBe('searching the web');
    expect(friendlyToolLabel('read_file')).toBe('reading a file');
    expect(friendlyToolLabel('memory_search')).toBe('searching memory');
  });

  test('replaces underscores and hyphens for unknown tools', () => {
    expect(friendlyToolLabel('custom_tool_name')).toBe('custom tool name');
    expect(friendlyToolLabel('my-tool')).toBe('my tool');
  });
});
