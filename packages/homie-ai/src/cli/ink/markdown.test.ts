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
});
