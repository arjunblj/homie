import type { Lifecycle } from './lifecycle.js';

export interface HealthDeps {
  lifecycle: Lifecycle;
  port?: number | undefined;
  checks?: Array<() => void> | undefined;
}

export function startHealthServer(deps: HealthDeps): ReturnType<typeof Bun.serve> {
  const port = deps.port ?? 9091;
  const checks = deps.checks ?? [];

  return Bun.serve({
    port,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/health') return new Response('Not found', { status: 404 });

      let ok = true;
      let detail: string | undefined;
      if (deps.lifecycle.isShuttingDown) {
        ok = false;
        detail = 'shutting_down';
      }
      for (const check of checks) {
        try {
          check();
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
