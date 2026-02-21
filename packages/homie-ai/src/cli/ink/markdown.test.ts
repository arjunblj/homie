import { describe, expect, test } from 'bun:test';

import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  test('returns a string for simple markdown input', () => {
    const result = renderMarkdown('**bold** and _italic_');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles headings', () => {
    const result = renderMarkdown('# Hello');
    expect(typeof result).toBe('string');
    expect(result).toContain('Hello');
  });

  test('handles empty string', () => {
    const result = renderMarkdown('');
    expect(typeof result).toBe('string');
  });

  test('strips trailing newlines', () => {
    const result = renderMarkdown('hello\n\n\n');
    expect(result).not.toMatch(/\n+$/u);
  });

  test('preserves plain text without markdown', () => {
    const plain = 'just a sentence with no formatting';
    const result = renderMarkdown(plain);
    expect(result).toContain('just a sentence');
  });

  test('strips ANSI control sequences', () => {
    const result = renderMarkdown('hello \u001b[31mred\u001b[0m');
    expect(result).toContain('hello');
    expect(result).toContain('red');
    expect(result).not.toContain('\u001b[');
  });

  test('strips OSC hyperlink sequences', () => {
    const input = 'safe \u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007';
    const result = renderMarkdown(input);
    expect(result).toContain('safe');
    expect(result).toContain('click');
    expect(result).not.toContain('\u001b]');
  });
});
