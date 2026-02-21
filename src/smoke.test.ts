import { expect, test } from 'bun:test';

import { TurnEngine } from './index.js';

test('exports TurnEngine', () => {
  expect(typeof TurnEngine).toBe('function');
});
