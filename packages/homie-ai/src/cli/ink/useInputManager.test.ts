import { describe, expect, test } from 'bun:test';

import { appendToInputHistory } from './useInputManager.js';

describe('appendToInputHistory', () => {
  test('appends a new entry', () => {
    const next = appendToInputHistory(['a', 'b'], 'c');
    expect(next).toEqual(['a', 'b', 'c']);
  });

  test('keeps only the latest 100 entries', () => {
    const history = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const next = appendToInputHistory(history, 'latest');
    expect(next).toHaveLength(100);
    expect(next[0]).toBe('m1');
    expect(next[99]).toBe('latest');
  });
});
