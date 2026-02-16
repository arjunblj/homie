import { z } from 'zod';

const TimeHHMM: z.ZodString = z
  .string()
  .regex(/^\d{2}:\d{2}$/u, 'Expected time in HH:MM (24-hour) format');

export interface HomieConfigFileParsed {
  schema_version?: number | undefined;
  model?:
    | {
        provider?: string | undefined;
        base_url?: string | undefined;
        default?: string | undefined;
        fast?: string | undefined;
      }
    | undefined;
  behavior?:
    | {
        timezone?: string | undefined;
        sleep_mode?: boolean | undefined;
        sleep_start?: string | undefined;
        sleep_end?: string | undefined;
        group_max_chars?: number | undefined;
        dm_max_chars?: number | undefined;
        min_delay_ms?: number | undefined;
        max_delay_ms?: number | undefined;
        debounce_ms?: number | undefined;
      }
    | undefined;
  tools?:
    | {
        shell?: boolean | undefined;
      }
    | undefined;
  paths?:
    | {
        identity_dir?: string | undefined;
        skills_dir?: string | undefined;
        data_dir?: string | undefined;
      }
    | undefined;
}

export const HomieConfigFileSchema: z.ZodType<HomieConfigFileParsed> = z
  .object({
    schema_version: z.number().int().positive().optional(),

    model: z
      .object({
        provider: z.string().min(1).optional(),
        base_url: z.string().url().optional(),
        default: z.string().min(1).optional(),
        fast: z.string().min(1).optional(),
      })
      .optional(),

    behavior: z
      .object({
        timezone: z.string().min(1).optional(),

        sleep_mode: z.boolean().optional(),
        sleep_start: TimeHHMM.optional(),
        sleep_end: TimeHHMM.optional(),

        group_max_chars: z.number().int().positive().optional(),
        dm_max_chars: z.number().int().positive().optional(),

        min_delay_ms: z.number().int().nonnegative().optional(),
        max_delay_ms: z.number().int().nonnegative().optional(),
        debounce_ms: z.number().int().nonnegative().optional(),
      })
      .optional(),

    tools: z
      .object({
        shell: z.boolean().optional(),
      })
      .optional(),

    paths: z
      .object({
        identity_dir: z.string().min(1).optional(),
        skills_dir: z.string().min(1).optional(),
        data_dir: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();
