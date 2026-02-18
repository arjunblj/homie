import { describe, expect, test } from 'bun:test';

import { startHealthServer } from './health.js';
import { Lifecycle } from './lifecycle.js';

describe('health server', () => {
  test('returns ok JSON and 200', async () => {
    const lifecycle = new Lifecycle();
    const server = startHealthServer({ lifecycle, port: 0 });
    try {
      const url = `http://127.0.0.1:${server.port}/health`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status?: string; uptimeSec?: number };
      expect(json.status).toBe('ok');
      expect(typeof json.uptimeSec).toBe('number');
    } finally {
      server.stop();
    }
  });

  test('returns 503 when a check fails', async () => {
    const lifecycle = new Lifecycle();
    const server = startHealthServer({
      lifecycle,
      port: 0,
      checks: [
        () => {
          throw new Error('nope');
        },
      ],
    });
    try {
      const url = `http://127.0.0.1:${server.port}/health`;
      const res = await fetch(url);
      expect(res.status).toBe(503);
      const json = (await res.json()) as { status?: string; detail?: string };
      expect(json.status).toBe('degraded');
      expect(json.detail).toContain('nope');
    } finally {
      server.stop();
    }
  });

  test('returns 503 when shutting down', async () => {
    const lifecycle = new Lifecycle();
    const server = startHealthServer({ lifecycle, port: 0 });
    try {
      await lifecycle.shutdown({ reason: 'test' });
      const url = `http://127.0.0.1:${server.port}/health`;
      const res = await fetch(url);
      expect(res.status).toBe(503);
      const json = (await res.json()) as { shuttingDown?: boolean; detail?: string };
      expect(json.shuttingDown).toBe(true);
      expect(json.detail).toContain('shutting_down');
    } finally {
      server.stop();
    }
  });
});
