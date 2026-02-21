import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { findUp, readTextFile } from '../util/fs.js';
import { assertConfigNumericBounds, assertHhMm, resolveDir } from './config-defaults.js';
import {
  assertModelName,
  isValidIanaTimeZone,
  nonEmptyTrimmed,
  normalizeToolAllowlist,
  type OpenhomieEnv,
  parseBoolEnvStrict,
  parseCsvEnv,
  parseIntEnv,
  parseNumberEnv,
  resolveProvider,
} from './config-env.js';
import { createDefaultConfig, getDefaultTimezone } from './defaults.js';
import type { OpenhomieConfig } from './types.js';
import { OpenhomieConfigFileSchema } from './zod.js';

export interface LoadOpenhomieConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedOpenhomieConfig {
  configPath: string;
  config: OpenhomieConfig;
}

export const loadOpenhomieConfig = async (
  options: LoadOpenhomieConfigOptions = {},
): Promise<LoadedOpenhomieConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const env = (options.env ?? process.env) as OpenhomieEnv;

  const configPath =
    options.configPath ?? env.OPENHOMIE_CONFIG_PATH ?? (await findUp('homie.toml', cwd));
  if (!configPath) {
    throw new Error(
      'Could not find homie.toml (set OPENHOMIE_CONFIG_PATH to override). Run `homie init` to create one.',
    );
  }

  const projectDir = path.dirname(configPath);
  const defaults = createDefaultConfig(projectDir);

  const tomlText = await readTextFile(configPath);
  let tomlUnknown: unknown;
  try {
    tomlUnknown = parseToml(tomlText) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
    throw new Error(`Malformed homie.toml (${configPath}): ${msg}`);
  }
  const parsed = OpenhomieConfigFileSchema.safeParse(tomlUnknown);
  if (!parsed.success) {
    throw new Error(`Invalid homie.toml: ${parsed.error.message}`);
  }

  const file = parsed.data;

  const provider = resolveProvider(
    env.OPENHOMIE_MODEL_PROVIDER ?? file.model?.provider,
    env.OPENHOMIE_MODEL_BASE_URL ?? file.model?.base_url,
  );

  const modelDefault =
    nonEmptyTrimmed(env.OPENHOMIE_MODEL_DEFAULT) ??
    nonEmptyTrimmed(file.model?.default) ??
    nonEmptyTrimmed(defaults.model.models.default);
  const modelFast =
    nonEmptyTrimmed(env.OPENHOMIE_MODEL_FAST) ?? nonEmptyTrimmed(file.model?.fast) ?? modelDefault;
  if (!modelDefault || !modelFast) {
    throw new Error('Model names must be non-empty (check model.default / model.fast).');
  }
  assertModelName('model.default', modelDefault);
  assertModelName('model.fast', modelFast);

  const timezone =
    env.OPENHOMIE_TIMEZONE ??
    file.behavior?.timezone ??
    defaults.behavior.sleep.timezone ??
    getDefaultTimezone();

  if (!isValidIanaTimeZone(timezone)) {
    throw new Error(
      `Invalid time zone "${timezone}" (expected an IANA TZ like "America/Los_Angeles" or "UTC")`,
    );
  }

  const sleepEnabled =
    parseBoolEnvStrict(env.OPENHOMIE_SLEEP_MODE, 'OPENHOMIE_SLEEP_MODE') ??
    file.behavior?.sleep_mode ??
    defaults.behavior.sleep.enabled;

  const identityDir = await resolveDir(
    projectDir,
    env.OPENHOMIE_IDENTITY_DIR ?? file.paths?.identity_dir ?? defaults.paths.identityDir,
    'identity_dir',
  );
  const skillsDir = await resolveDir(
    projectDir,
    env.OPENHOMIE_SKILLS_DIR ?? file.paths?.skills_dir ?? defaults.paths.skillsDir,
    'skills_dir',
  );
  const dataDir = await resolveDir(
    projectDir,
    env.OPENHOMIE_DATA_DIR ?? file.paths?.data_dir ?? defaults.paths.dataDir,
    'data_dir',
  );

  const restrictedEnabledForOperator =
    parseBoolEnvStrict(
      env.OPENHOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR,
      'OPENHOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR',
    ) ??
    file.tools?.restricted_enabled_for_operator ??
    defaults.tools.restricted.enabledForOperator;
  const restrictedAllowlist =
    parseCsvEnv(env.OPENHOMIE_TOOLS_RESTRICTED_ALLOWLIST, 'OPENHOMIE_TOOLS_RESTRICTED_ALLOWLIST') ??
    file.tools?.restricted_allowlist ??
    defaults.tools.restricted.allowlist;

  const dangerousEnabledForOperator =
    parseBoolEnvStrict(
      env.OPENHOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR,
      'OPENHOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR',
    ) ??
    file.tools?.dangerous_enabled_for_operator ??
    defaults.tools.dangerous.enabledForOperator;
  const dangerousAllowAll =
    parseBoolEnvStrict(
      env.OPENHOMIE_TOOLS_DANGEROUS_ALLOW_ALL,
      'OPENHOMIE_TOOLS_DANGEROUS_ALLOW_ALL',
    ) ??
    file.tools?.dangerous_allow_all ??
    defaults.tools.dangerous.allowAll;
  const dangerousAllowlist =
    parseCsvEnv(env.OPENHOMIE_TOOLS_DANGEROUS_ALLOWLIST, 'OPENHOMIE_TOOLS_DANGEROUS_ALLOWLIST') ??
    file.tools?.dangerous_allowlist ??
    defaults.tools.dangerous.allowlist;
  const normalizedRestrictedAllowlist = normalizeToolAllowlist(
    'tools.restricted_allowlist',
    restrictedAllowlist,
  );
  const normalizedDangerousAllowlist = normalizeToolAllowlist(
    'tools.dangerous_allowlist',
    dangerousAllowlist,
  );
  if (dangerousAllowAll && normalizedDangerousAllowlist.length > 0) {
    throw new Error(
      'tools.dangerous_allowlist must be empty when tools.dangerous_allow_all is true',
    );
  }

  const memEnabled = file.memory?.enabled ?? defaults.memory.enabled;
  const capsuleEnabled =
    memEnabled && (file.memory?.capsule_enabled ?? defaults.memory.capsule.enabled);
  const decayEnabled = memEnabled && (file.memory?.decay_enabled ?? defaults.memory.decay.enabled);
  const feedbackEnabled =
    memEnabled && (file.memory?.feedback_enabled ?? defaults.memory.feedback.enabled);

  const config: OpenhomieConfig = {
    schemaVersion: file.schema_version ?? defaults.schemaVersion,
    model: {
      provider,
      models: {
        default: modelDefault,
        fast: modelFast,
      },
    },
    engine: {
      limiter: {
        capacity:
          parseIntEnv(env.OPENHOMIE_ENGINE_LIMITER_CAPACITY) ??
          file.engine?.limiter_capacity ??
          defaults.engine.limiter.capacity,
        refillPerSecond:
          parseNumberEnv(env.OPENHOMIE_ENGINE_LIMITER_REFILL_PER_SECOND) ??
          file.engine?.limiter_refill_per_second ??
          defaults.engine.limiter.refillPerSecond,
      },
      perChatLimiter: {
        capacity:
          parseIntEnv(env.OPENHOMIE_ENGINE_PER_CHAT_CAPACITY) ??
          file.engine?.per_chat_capacity ??
          defaults.engine.perChatLimiter.capacity,
        refillPerSecond:
          parseNumberEnv(env.OPENHOMIE_ENGINE_PER_CHAT_REFILL_PER_SECOND) ??
          file.engine?.per_chat_refill_per_second ??
          defaults.engine.perChatLimiter.refillPerSecond,
        staleAfterMs:
          parseIntEnv(env.OPENHOMIE_ENGINE_PER_CHAT_STALE_AFTER_MS) ??
          file.engine?.per_chat_stale_after_ms ??
          defaults.engine.perChatLimiter.staleAfterMs,
        sweepInterval:
          parseIntEnv(env.OPENHOMIE_ENGINE_PER_CHAT_SWEEP_INTERVAL) ??
          file.engine?.per_chat_sweep_interval ??
          defaults.engine.perChatLimiter.sweepInterval,
      },
      session: {
        fetchLimit:
          parseIntEnv(env.OPENHOMIE_ENGINE_SESSION_FETCH_LIMIT) ??
          file.engine?.session_fetch_limit ??
          defaults.engine.session.fetchLimit,
      },
      context: {
        maxTokensDefault:
          parseIntEnv(env.OPENHOMIE_ENGINE_CONTEXT_MAX_TOKENS_DEFAULT) ??
          file.engine?.context_max_tokens_default ??
          defaults.engine.context.maxTokensDefault,
        identityPromptMaxTokens:
          parseIntEnv(env.OPENHOMIE_ENGINE_IDENTITY_PROMPT_MAX_TOKENS) ??
          file.engine?.identity_prompt_max_tokens ??
          defaults.engine.context.identityPromptMaxTokens,
        promptSkillsMaxTokens:
          parseIntEnv(env.OPENHOMIE_ENGINE_PROMPT_SKILLS_MAX_TOKENS) ??
          file.engine?.prompt_skills_max_tokens ??
          defaults.engine.context.promptSkillsMaxTokens,
      },
      generation: {
        reactiveMaxSteps:
          parseIntEnv(env.OPENHOMIE_ENGINE_GENERATION_REACTIVE_MAX_STEPS) ??
          file.engine?.generation_reactive_max_steps ??
          defaults.engine.generation.reactiveMaxSteps,
        proactiveMaxSteps:
          parseIntEnv(env.OPENHOMIE_ENGINE_GENERATION_PROACTIVE_MAX_STEPS) ??
          file.engine?.generation_proactive_max_steps ??
          defaults.engine.generation.proactiveMaxSteps,
        maxRegens:
          parseIntEnv(env.OPENHOMIE_ENGINE_GENERATION_MAX_REGENS) ??
          file.engine?.generation_max_regens ??
          defaults.engine.generation.maxRegens,
      },
    },
    behavior: {
      sleep: {
        enabled: sleepEnabled,
        timezone,
        startLocal: file.behavior?.sleep_start ?? defaults.behavior.sleep.startLocal,
        endLocal: file.behavior?.sleep_end ?? defaults.behavior.sleep.endLocal,
      },
      groupMaxChars: file.behavior?.group_max_chars ?? defaults.behavior.groupMaxChars,
      dmMaxChars: file.behavior?.dm_max_chars ?? defaults.behavior.dmMaxChars,
      minDelayMs: file.behavior?.min_delay_ms ?? defaults.behavior.minDelayMs,
      maxDelayMs: file.behavior?.max_delay_ms ?? defaults.behavior.maxDelayMs,
      debounceMs: file.behavior?.debounce_ms ?? defaults.behavior.debounceMs,
    },
    proactive: {
      enabled: file.proactive?.enabled ?? defaults.proactive.enabled,
      heartbeatIntervalMs:
        file.proactive?.heartbeat_interval_ms ?? defaults.proactive.heartbeatIntervalMs,
      dm: {
        maxPerDay: file.proactive?.dm?.max_per_day ?? defaults.proactive.dm.maxPerDay,
        maxPerWeek: file.proactive?.dm?.max_per_week ?? defaults.proactive.dm.maxPerWeek,
        cooldownAfterUserMs:
          file.proactive?.dm?.cooldown_after_user_ms ?? defaults.proactive.dm.cooldownAfterUserMs,
        pauseAfterIgnored:
          file.proactive?.dm?.pause_after_ignored ?? defaults.proactive.dm.pauseAfterIgnored,
      },
      group: {
        maxPerDay: file.proactive?.group?.max_per_day ?? defaults.proactive.group.maxPerDay,
        maxPerWeek: file.proactive?.group?.max_per_week ?? defaults.proactive.group.maxPerWeek,
        cooldownAfterUserMs:
          file.proactive?.group?.cooldown_after_user_ms ??
          defaults.proactive.group.cooldownAfterUserMs,
        pauseAfterIgnored:
          file.proactive?.group?.pause_after_ignored ?? defaults.proactive.group.pauseAfterIgnored,
      },
    },
    memory: {
      enabled: memEnabled,
      contextBudgetTokens:
        file.memory?.context_budget_tokens ?? defaults.memory.contextBudgetTokens,
      capsule: {
        enabled: capsuleEnabled,
        maxTokens: file.memory?.capsule_max_tokens ?? defaults.memory.capsule.maxTokens,
      },
      decay: {
        enabled: decayEnabled,
        halfLifeDays: file.memory?.decay_half_life_days ?? defaults.memory.decay.halfLifeDays,
      },
      retrieval: {
        rrfK:
          parseIntEnv(env.OPENHOMIE_MEMORY_RETRIEVAL_RRF_K) ??
          file.memory?.retrieval_rrf_k ??
          defaults.memory.retrieval.rrfK,
        ftsWeight:
          parseNumberEnv(env.OPENHOMIE_MEMORY_RETRIEVAL_FTS_WEIGHT) ??
          file.memory?.retrieval_fts_weight ??
          defaults.memory.retrieval.ftsWeight,
        vecWeight:
          parseNumberEnv(env.OPENHOMIE_MEMORY_RETRIEVAL_VEC_WEIGHT) ??
          file.memory?.retrieval_vec_weight ??
          defaults.memory.retrieval.vecWeight,
        recencyWeight:
          parseNumberEnv(env.OPENHOMIE_MEMORY_RETRIEVAL_RECENCY_WEIGHT) ??
          file.memory?.retrieval_recency_weight ??
          defaults.memory.retrieval.recencyWeight,
      },
      feedback: {
        enabled: feedbackEnabled,
        finalizeAfterMs:
          file.memory?.feedback_finalize_after_ms ?? defaults.memory.feedback.finalizeAfterMs,
        successThreshold:
          file.memory?.feedback_success_threshold ?? defaults.memory.feedback.successThreshold,
        failureThreshold:
          file.memory?.feedback_failure_threshold ?? defaults.memory.feedback.failureThreshold,
      },
      consolidation: {
        enabled:
          memEnabled &&
          (file.memory?.consolidation_enabled ?? defaults.memory.consolidation.enabled),
        intervalMs:
          file.memory?.consolidation_interval_ms ?? defaults.memory.consolidation.intervalMs,
        modelRole: file.memory?.consolidation_model_role ?? defaults.memory.consolidation.modelRole,
        maxEpisodesPerRun:
          file.memory?.consolidation_max_episodes_per_run ??
          defaults.memory.consolidation.maxEpisodesPerRun,
        dirtyGroupLimit:
          file.memory?.consolidation_dirty_group_limit ??
          defaults.memory.consolidation.dirtyGroupLimit,
        dirtyPublicStyleLimit:
          file.memory?.consolidation_dirty_public_style_limit ??
          defaults.memory.consolidation.dirtyPublicStyleLimit,
        dirtyPersonLimit:
          file.memory?.consolidation_dirty_person_limit ??
          defaults.memory.consolidation.dirtyPersonLimit,
      },
    },
    tools: {
      restricted: {
        enabledForOperator: restrictedEnabledForOperator,
        allowlist: normalizedRestrictedAllowlist,
      },
      dangerous: {
        enabledForOperator: dangerousEnabledForOperator,
        allowAll: dangerousAllowAll,
        allowlist: normalizedDangerousAllowlist,
      },
    },
    paths: {
      projectDir,
      identityDir,
      skillsDir,
      dataDir,
    },
  };

  if (config.behavior.minDelayMs > config.behavior.maxDelayMs) {
    throw new Error(
      `behavior.min_delay_ms (${config.behavior.minDelayMs}) must be <= behavior.max_delay_ms (${config.behavior.maxDelayMs})`,
    );
  }

  assertHhMm('behavior.sleep_start', config.behavior.sleep.startLocal);
  assertHhMm('behavior.sleep_end', config.behavior.sleep.endLocal);

  assertConfigNumericBounds(config);

  return { configPath, config };
};
