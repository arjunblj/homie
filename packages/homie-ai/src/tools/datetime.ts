import { z } from 'zod';

import { defineTool } from './define.js';
import type { ToolDef } from './types.js';

const DateTimeInputSchema = z.object({
  timeZone: z.string().optional().describe('IANA timezone, e.g. America/Los_Angeles'),
});

export const datetimeTool: ToolDef = defineTool({
  name: 'datetime',
  tier: 'safe',
  description: 'Get the current datetime (optionally in a timezone).',
  inputSchema: DateTimeInputSchema,
  execute: async ({ timeZone }, ctx) => {
    const now = ctx.now;
    if (!timeZone) {
      return {
        iso: now.toISOString(),
        epochMs: now.getTime(),
      };
    }

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    return {
      iso: now.toISOString(),
      epochMs: now.getTime(),
      timeZone,
      local: fmt.format(now),
    };
  },
});
