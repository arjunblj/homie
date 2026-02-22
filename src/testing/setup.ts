if (!process.env.TZ) {
  process.env.TZ = 'UTC';
}

// Keep tests quiet by default (can override locally when debugging).
{
  const env = process.env as NodeJS.ProcessEnv & { OPENHOMIE_LOG_LEVEL?: string };
  if (!env.OPENHOMIE_LOG_LEVEL) {
    env.OPENHOMIE_LOG_LEVEL = 'fatal';
  }
}
