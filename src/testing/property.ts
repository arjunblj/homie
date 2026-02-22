import { test } from 'bun:test';

/**
 * Property-based testing utility for Bun.
 * Generates random inputs and verifies invariants hold.
 *
 * @param name - Test name
 * @param generator - Function that generates a test value
 * @param predicate - Function that checks if the value satisfies the property
 * @param iterations - Number of random tests to run (default: 1000)
 */
export function propertyTest<T>(
  name: string,
  generator: () => T,
  predicate: (value: T) => boolean,
  iterations = 1000,
): void {
  test(`property: ${name}`, () => {
    for (let i = 0; i < iterations; i++) {
      const value = generator();
      if (!predicate(value)) {
        throw new Error(
          `Property violation: ${name}\n` +
            `Iteration: ${i}\n` +
            `Value: ${JSON.stringify(value, null, 2)}`,
        );
      }
    }
  });
}
