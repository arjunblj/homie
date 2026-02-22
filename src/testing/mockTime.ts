export interface MockTime {
  now: () => number;
  set: (ms: number) => void;
  advance: (ms: number) => void;
}

export async function withMockedDateNow<T>(
  startMs: number,
  fn: (t: MockTime) => T | Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  let cur = startMs;
  Date.now = () => cur;
  const api: MockTime = {
    now: () => cur,
    set: (ms) => {
      cur = ms;
    },
    advance: (ms) => {
      cur += ms;
    },
  };
  try {
    return await fn(api);
  } finally {
    Date.now = realNow;
  }
}
