import { describe, expect, test } from 'bun:test';

import { datetimeTool } from './datetime.js';

describe('datetimeTool', () => {
  test('returns ISO + epochMs', async () => {
    const out = (await datetimeTool.execute({}, { now: new Date('2026-02-16T00:00:00.000Z') })) as {
      iso: string;
      epochMs: number;
    };
    expect(out.iso).toBe('2026-02-16T00:00:00.000Z');
    expect(out.epochMs).toBe(1771200000000);
  });

  test('formats local time when timezone provided', async () => {
    const out = (await datetimeTool.execute(
      { timeZone: 'UTC' },
      { now: new Date('2026-02-16T00:00:00.000Z') },
    )) as { local?: string };
    expect(typeof out.local).toBe('string');
  });
});

