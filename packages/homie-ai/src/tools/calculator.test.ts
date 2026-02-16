import { describe, expect, test } from 'bun:test';

import { calculatorTool } from './calculator.js';

describe('calculatorTool', () => {
  test('evaluates expression with parentheses', async () => {
    const out = (await calculatorTool.execute({ expression: '2*(3+4)' }, { now: new Date() })) as {
      value: number;
    };
    expect(out.value).toBe(14);
  });

  test('rejects invalid input schema', async () => {
    await expect(calculatorTool.execute({}, { now: new Date() })).rejects.toThrow('Invalid tool input');
  });

  test('handles whitespace and operator precedence', async () => {
    const out = (await calculatorTool.execute(
      { expression: ' \t1 + 2 * 3\n' },
      { now: new Date() },
    )) as { value: number };
    expect(out.value).toBe(7);
  });

  test('handles left-associative same-precedence operators', async () => {
    const out = (await calculatorTool.execute({ expression: '8/4/2' }, { now: new Date() })) as {
      value: number;
    };
    expect(out.value).toBe(1);
  });

  test('rejects invalid character', async () => {
    await expect(calculatorTool.execute({ expression: '2^3' }, { now: new Date() })).rejects.toThrow(
      'Invalid character',
    );
  });

  test('rejects non-finite result', async () => {
    await expect(calculatorTool.execute({ expression: '1/0' }, { now: new Date() })).rejects.toThrow(
      'not finite',
    );
  });
});

