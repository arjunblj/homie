import type { Lifecycle } from './lifecycle.js';

export interface HealthDeps {
  lifecycle: Lifecycle;
  port?: number | undefined;
  checks?: Array<() => void | Promise<void>> | undefined;
  checkTimeoutMs?: number | undefined;
}

class CheckTimeoutError extends Error {
  public override readonly name = 'CheckTimeoutError';
}

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error?: unknown }> => {
  const waitMs = Math.max(1, Math.floor(ms));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError('timeout')), waitMs);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, timedOut: err instanceof CheckTimeoutError, error: err };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export function startHealthServer(deps: HealthDeps): ReturnType<typeof Bun.serve> {
  const port = deps.port ?? 9091;
  const checks = deps.checks ?? [];
  const checkTimeoutMs = deps.checkTimeoutMs ?? 1500;

  return Bun.serve({
    port,
    fetch: async (req) => {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch (_err) {
        return new Response('Bad request', { status: 400 });
      }
      if (url.pathname !== '/health') return new Response('Not found', { status: 404 });

      let ok = true;
      let detail: string | undefined;
      if (deps.lifecycle.isShuttingDown) {
        ok = false;
        detail = 'shutting_down';
      }
      for (const check of checks) {
        try {
          const res = await withTimeout(
            Promise.resolve().then(() => check()),
            checkTimeoutMs,
          );
          if (!res.ok) {
            if (res.timedOut) throw new Error('check_timeout');
            throw res.error;
          }
        } catch (err) {
          ok = false;
          detail = err instanceof Error ? err.message : String(err);
          break;
        }
      }

      const last = deps.lifecycle.getLastSuccessfulTurnMs();
      const now = Date.now();
      const body = {
        status: ok ? 'ok' : 'degraded',
        uptimeSec: Math.floor(process.uptime()),
        shuttingDown: deps.lifecycle.isShuttingDown,
        lastSuccessfulTurnMs: last,
        lastTurnAgoSec: last ? Math.floor((now - last) / 1000) : null,
        ...(detail ? { detail } : {}),
      };

      return Response.json(body, { status: ok ? 200 : 503 });
    },
  });
}
