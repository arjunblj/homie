export async function withMockFetch<T>(
  fetchImpl: typeof fetch,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prior;
  }
}
