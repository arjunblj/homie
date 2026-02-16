import { describe, expect, test } from 'bun:test';

import { asChatId, asGroupId, asMessageId, asUserId } from './ids.js';

describe('types/ids', () => {
  test('brands ids without changing runtime value', () => {
    expect(String(asChatId('c'))).toBe('c');
    expect(String(asMessageId('m'))).toBe('m');
    expect(String(asUserId('u'))).toBe('u');
    expect(String(asGroupId('g'))).toBe('g');
  });
});

