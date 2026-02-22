import { test } from 'bun:test';
import fc, { type Arbitrary } from 'fast-check';

export interface FcConfig {
  readonly seed?: number;
  readonly numRuns?: number;
}

const readEnvInt = (key: string): number | undefined => {
  const v = process.env[key];
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

const defaultConfig = (): Required<FcConfig> => {
  const seed = readEnvInt('FC_SEED') ?? 0;
  // Keep PR CI fast and deterministic. Increase locally when hunting a flaky edge case.
  const numRuns = readEnvInt('FC_RUNS') ?? (process.env.CI ? 10 : 50);
  return { seed, numRuns };
};

export function fcPropertyTest<T>(
  name: string,
  arb: Arbitrary<T>,
  predicate: (value: T) => void | Promise<void>,
  config: FcConfig = {},
): void {
  test(`property: ${name}`, async () => {
    const defaults = defaultConfig();
    const seed = config.seed ?? defaults.seed;
    const numRuns = config.numRuns ?? defaults.numRuns;

    await fc.assert(
      fc.asyncProperty(arb, async (value) => {
        await predicate(value);
      }),
      { seed, numRuns, verbose: false },
    );
  });
}
