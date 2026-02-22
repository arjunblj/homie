if (!process.env.TZ) {
  process.env.TZ = 'UTC';
}

// Keep tests quiet by default (can override locally when debugging).
if (!process.env.OPENHOMIE_LOG_LEVEL) {
  process.env.OPENHOMIE_LOG_LEVEL = 'fatal';
}
