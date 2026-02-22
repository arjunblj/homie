import { z } from 'zod';

const TimeHHMM: z.ZodString = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Expected time in HH:MM (24-hour) format');

export interface OpenhomieConfigFileParsed {
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
  proactive?:
    | {
        enabled?: boolean | undefined;
        heartbeat_interval_ms?: number | undefined;
        dm?:
          | {
              max_per_day?: number | undefined;
              max_per_week?: number | undefined;
              cooldown_after_user_ms?: number | undefined;
              pause_after_ignored?: number | undefined;
            }
          | undefined;
        group?:
          | {
              max_per_day?: number | undefined;
              max_per_week?: number | undefined;
              cooldown_after_user_ms?: number | undefined;
              pause_after_ignored?: number | undefined;
            }
          | undefined;
      }
    | undefined;
  memory?:
    | {
        enabled?: boolean | undefined;
        context_budget_tokens?: number | undefined;
        capsule_enabled?: boolean | undefined;
        capsule_max_tokens?: number | undefined;
        decay_enabled?: boolean | undefined;
        decay_half_life_days?: number | undefined;
        retrieval_rrf_k?: number | undefined;
        retrieval_fts_weight?: number | undefined;
        retrieval_vec_weight?: number | undefined;
        retrieval_recency_weight?: number | undefined;
        feedback_enabled?: boolean | undefined;
        feedback_finalize_after_ms?: number | undefined;
        feedback_success_threshold?: number | undefined;
        feedback_failure_threshold?: number | undefined;
        consolidation_enabled?: boolean | undefined;
        consolidation_interval_ms?: number | undefined;
        consolidation_model_role?: 'default' | 'fast' | undefined;
        consolidation_max_episodes_per_run?: number | undefined;
        consolidation_dirty_group_limit?: number | undefined;
        consolidation_dirty_public_style_limit?: number | undefined;
        consolidation_dirty_person_limit?: number | undefined;
      }
    | undefined;
  tools?:
    | {
        restricted_enabled_for_operator?: boolean | undefined;
        restricted_allowlist?: string[] | undefined;
        dangerous_enabled_for_operator?: boolean | undefined;
        dangerous_allow_all?: boolean | undefined;
        dangerous_allowlist?: string[] | undefined;
      }
    | undefined;
  engine?:
    | {
        limiter_capacity?: number | undefined;
        limiter_refill_per_second?: number | undefined;
        per_chat_capacity?: number | undefined;
        per_chat_refill_per_second?: number | undefined;
        per_chat_stale_after_ms?: number | undefined;
        per_chat_sweep_interval?: number | undefined;
        session_fetch_limit?: number | undefined;
        context_max_tokens_default?: number | undefined;
        identity_prompt_max_tokens?: number | undefined;
        prompt_skills_max_tokens?: number | undefined;
        generation_reactive_max_steps?: number | undefined;
        generation_proactive_max_steps?: number | undefined;
        generation_max_regens?: number | undefined;
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

export const OpenhomieConfigFileSchema: z.ZodType<OpenhomieConfigFileParsed> = z
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

        group_max_chars: z.number().int().min(50).max(1000).default(240),
        dm_max_chars: z.number().int().min(50).max(2000).default(420),

        min_delay_ms: z.number().int().nonnegative().max(600_000).optional(),
        max_delay_ms: z.number().int().nonnegative().max(600_000).optional(),
        debounce_ms: z.number().int().nonnegative().max(600_000).optional(),
      })
      .optional(),

    proactive: z
      .object({
        enabled: z.boolean().optional(),
        heartbeat_interval_ms: z.number().int().positive().max(86_400_000).optional(),
        dm: z
          .object({
            max_per_day: z.number().int().nonnegative().max(20).optional(),
            max_per_week: z.number().int().nonnegative().max(100).optional(),
            cooldown_after_user_ms: z
              .number()
              .int()
              .nonnegative()
              .max(30 * 24 * 60 * 60_000)
              .optional(),
            pause_after_ignored: z.number().int().nonnegative().max(100).optional(),
          })
          .optional(),
        group: z
          .object({
            max_per_day: z.number().int().nonnegative().max(20).optional(),
            max_per_week: z.number().int().nonnegative().max(100).optional(),
            cooldown_after_user_ms: z
              .number()
              .int()
              .nonnegative()
              .max(30 * 24 * 60 * 60_000)
              .optional(),
            pause_after_ignored: z.number().int().nonnegative().max(100).optional(),
          })
          .optional(),
      })
      .optional(),

    memory: z
      .object({
        enabled: z.boolean().optional(),
        context_budget_tokens: z.number().int().positive().max(50_000).optional(),
        capsule_enabled: z.boolean().optional(),
        capsule_max_tokens: z.number().int().positive().max(10_000).optional(),
        decay_enabled: z.boolean().optional(),
        decay_half_life_days: z.number().positive().max(3650).optional(),
        retrieval_rrf_k: z.number().int().positive().max(500).optional(),
        retrieval_fts_weight: z.number().nonnegative().max(10).optional(),
        retrieval_vec_weight: z.number().nonnegative().max(10).optional(),
        retrieval_recency_weight: z.number().nonnegative().max(10).optional(),
        feedback_enabled: z.boolean().optional(),
        feedback_finalize_after_ms: z
          .number()
          .int()
          .positive()
          .max(30 * 24 * 60 * 60_000)
          .optional(),
        feedback_success_threshold: z.number().min(0).max(1).optional(),
        feedback_failure_threshold: z.number().min(-1).max(0).optional(),
        consolidation_enabled: z.boolean().optional(),
        consolidation_interval_ms: z
          .number()
          .int()
          .positive()
          .max(30 * 24 * 60 * 60_000)
          .optional(),
        consolidation_model_role: z.enum(['default', 'fast']).optional(),
        consolidation_max_episodes_per_run: z.number().int().positive().max(1000).optional(),
        consolidation_dirty_group_limit: z.number().int().nonnegative().max(1000).optional(),
        consolidation_dirty_public_style_limit: z.number().int().nonnegative().max(1000).optional(),
        consolidation_dirty_person_limit: z.number().int().nonnegative().max(1000).optional(),
      })
      .optional(),

    tools: z
      .object({
        restricted_enabled_for_operator: z.boolean().optional(),
        restricted_allowlist: z.array(z.string().min(1)).optional(),
        dangerous_enabled_for_operator: z.boolean().optional(),
        dangerous_allow_all: z.boolean().optional(),
        dangerous_allowlist: z.array(z.string().min(1)).optional(),
      })
      .optional(),

    engine: z
      .object({
        limiter_capacity: z.number().int().positive().max(1000).optional(),
        limiter_refill_per_second: z.number().positive().max(100).optional(),
        per_chat_capacity: z.number().int().positive().max(1000).optional(),
        per_chat_refill_per_second: z.number().positive().max(100).optional(),
        per_chat_stale_after_ms: z
          .number()
          .int()
          .positive()
          .max(30 * 24 * 60 * 60_000)
          .optional(),
        per_chat_sweep_interval: z.number().int().positive().max(10_000).optional(),
        session_fetch_limit: z.number().int().positive().max(2000).optional(),
        context_max_tokens_default: z.number().int().positive().max(200_000).optional(),
        identity_prompt_max_tokens: z.number().int().positive().max(200_000).optional(),
        prompt_skills_max_tokens: z.number().int().positive().max(200_000).optional(),
        generation_reactive_max_steps: z.number().int().positive().max(200).optional(),
        generation_proactive_max_steps: z.number().int().positive().max(200).optional(),
        generation_max_regens: z.number().int().nonnegative().max(10).optional(),
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
