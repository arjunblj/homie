import { type Tool, tool } from 'ai';
import { z } from 'zod';

export const datetimeTool: Tool = tool({
  description: 'Get the current datetime (optionally in a timezone).',
  inputSchema: z.object({
    timeZone: z.string().optional().describe('IANA timezone, e.g. America/Los_Angeles'),
  }),
  execute: async ({ timeZone }) => {
    const now = new Date();
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
