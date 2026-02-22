export async function withMockEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const env = process.env as NodeJS.ProcessEnv;
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prior[k] = env[k];
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}
