import { expect, test } from 'bun:test';

import { HOMIE_AI_VERSION } from './index.js';

test('exports version string', () => {
  expect(typeof HOMIE_AI_VERSION).toBe('string');
});

