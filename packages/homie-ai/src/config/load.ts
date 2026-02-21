import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { findUp, readTextFile } from '../util/fs.js';
import { createDefaultConfig, getDefaultTimezone } from './defaults.js';
import type { HomieConfig, HomieProvider } from './types.js';
import { HomieConfigFileSchema } from './zod.js';

export interface LoadHomieConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedHomieConfig {
  configPath: string;
  config: HomieConfig;
}

interface HomieEnv extends NodeJS.ProcessEnv {
  HOMIE_CONFIG_PATH?: string;
  HOMIE_MODEL_PROVIDER?: string;
  HOMIE_MODEL_BASE_URL?: string;
  HOMIE_MODEL_DEFAULT?: string;
  HOMIE_MODEL_FAST?: string;
  HOMIE_TIMEZONE?: string;
  HOMIE_SLEEP_MODE?: string;
  HOMIE_IDENTITY_DIR?: string;
  HOMIE_SKILLS_DIR?: string;
  HOMIE_DATA_DIR?: string;
  HOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR?: string;
  HOMIE_TOOLS_RESTRICTED_ALLOWLIST?: string;
  HOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR?: string;
  HOMIE_TOOLS_DANGEROUS_ALLOW_ALL?: string;
  HOMIE_TOOLS_DANGEROUS_ALLOWLIST?: string;
  HOMIE_ENGINE_LIMITER_CAPACITY?: string;
  HOMIE_ENGINE_LIMITER_REFILL_PER_SECOND?: string;
  HOMIE_ENGINE_PER_CHAT_CAPACITY?: string;
  HOMIE_ENGINE_PER_CHAT_REFILL_PER_SECOND?: string;
  HOMIE_ENGINE_PER_CHAT_STALE_AFTER_MS?: string;
  HOMIE_ENGINE_PER_CHAT_SWEEP_INTERVAL?: string;
  HOMIE_ENGINE_SESSION_FETCH_LIMIT?: string;
  HOMIE_ENGINE_CONTEXT_MAX_TOKENS_DEFAULT?: string;
  HOMIE_ENGINE_IDENTITY_PROMPT_MAX_TOKENS?: string;
  HOMIE_ENGINE_PROMPT_SKILLS_MAX_TOKENS?: string;
  HOMIE_ENGINE_GENERATION_REACTIVE_MAX_STEPS?: string;
  HOMIE_ENGINE_GENERATION_PROACTIVE_MAX_STEPS?: string;
  HOMIE_ENGINE_GENERATION_MAX_REGENS?: string;
  HOMIE_MEMORY_RETRIEVAL_RRF_K?: string;
  HOMIE_MEMORY_RETRIEVAL_FTS_WEIGHT?: string;
  HOMIE_MEMORY_RETRIEVAL_VEC_WEIGHT?: string;
  HOMIE_MEMORY_RETRIEVAL_RECENCY_WEIGHT?: string;
}

const parseBoolEnv = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return undefined;
};

const parseBoolEnvStrict = (value: string | undefined, label: string): boolean | undefined => {
  const parsed = parseBoolEnv(value);
  if (value !== undefined && parsed === undefined) {
    throw new Error(`Invalid ${label}: expected true/false/1/0/yes/no/on/off`);
  }
  return parsed;
};

const parseCsvEnv = (value: string | undefined, label: string): string[] | undefined => {
  if (value === undefined) return undefined;
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (!ch) continue;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\') {
        const next = value[i + 1];
        if (next === quote) {
          current += quote;
          i += 1;
          continue;
        }
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      const item = current.trim();
      if (item) out.push(item);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error(`Invalid ${label}: unclosed quote in comma-separated list`);
  }
  const last = current.trim();
  if (last) out.push(last);
  return out;
};

const parseNumberEnv = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
};

const parseIntEnv = (value: string | undefined): number | undefined => {
  const n = parseNumberEnv(value);
  if (n === undefined) return undefined;
  return Math.trunc(n);
};

const isPathWithin = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || rel === '.' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const realpathBestEffort = async (target: string): Promise<string> => {
  return await realpath(target).catch((_err) => path.resolve(target));
};

const nearestExistingAncestor = async (target: string): Promise<string> => {
  let cursor = path.resolve(target);
  for (;;) {
    const exists = await lstat(cursor)
      .then(() => true)
      .catch((_err) => false);
    if (exists) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
};

const resolveDir = async (
  projectDir: string,
  maybeRelative: string,
  label: string,
): Promise<string> => {
  const resolved = path.isAbsolute(maybeRelative)
    ? path.normalize(maybeRelative)
    : path.resolve(projectDir, maybeRelative);

  const projectRoot = path.resolve(projectDir);
  if (!isPathWithin(projectRoot, resolved)) {
    throw new Error(`paths.${label} must be within the project directory (${projectRoot})`);
  }
  const projectRootReal = await realpathBestEffort(projectRoot);
  const ancestor = await nearestExistingAncestor(resolved);
  const ancestorReal = await realpathBestEffort(ancestor);
  if (!isPathWithin(projectRootReal, ancestorReal)) {
    throw new Error(`paths.${label} must resolve within the project directory (${projectRoot})`);
  }
  return resolved;
};

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

const normalizeToolAllowlist = (label: string, values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (!TOOL_NAME_PATTERN.test(value)) {
      throw new Error(
        `Invalid ${label} entry "${raw}" (expected pattern ${TOOL_NAME_PATTERN.toString()})`,
      );
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const normalizeProviderBaseUrl = (raw: string | undefined, label: string): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_err) {
    throw new Error(`Invalid ${label}: expected a valid http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${label}: expected a valid http(s) URL`);
  }
  return parsed.toString().replace(/\/+$/u, '');
};

const resolveProvider = (providerRaw: string | undefined, baseUrlRaw?: string): HomieProvider => {
  const provider = (providerRaw ?? 'anthropic').toLowerCase();
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrlRaw, 'model.base_url');
  if (provider === 'anthropic') return { kind: 'anthropic' };
  if (provider === 'claude-code' || provider === 'claude_code') return { kind: 'claude-code' };
  if (provider === 'codex-cli' || provider === 'codex_cli' || provider === 'codex')
    return { kind: 'codex-cli' };
  if (provider === 'mpp') {
    return { kind: 'mpp', baseUrl: normalizedBaseUrl ?? 'https://mpp.tempo.xyz' };
  }

  if (provider === 'openrouter')
    return { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' };
  if (provider === 'openai')
    return { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };
  if (provider === 'ollama')
    return { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' };
  if (provider === 'openai-compatible' || provider === 'openai_compatible') {
    return normalizedBaseUrl
      ? { kind: 'openai-compatible', baseUrl: normalizedBaseUrl }
      : { kind: 'openai-compatible' };
  }

  throw new Error(
    `Unknown model provider "${providerRaw ?? ''}" (expected one of: anthropic, claude-code, codex-cli, mpp, openrouter, openai, ollama, openai-compatible)`,
  );
};

const nonEmptyTrimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v : undefined;
};

const assertModelName = (label: string, value: string): void => {
  if (!value || value.length > 200 || /\s/u.test(value)) {
    throw new Error(
      `Invalid ${label}: expected 1-200 visible non-whitespace characters (got "${value}")`,
    );
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `Invalid ${label}: expected 1-200 visible non-whitespace characters (got "${value}")`,
      );
    }
  }
};

const isValidIanaTimeZone = (tz: string): boolean => {
  try {
    // Intl throws RangeError on unknown time zones.
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch (_err) {
    return false;
  }
};

const assertFiniteNumber = (label: string, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
};

const assertIntInRange = (label: string, value: number, min: number, max: number): void => {
  assertFiniteNumber(label, value);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
};

const assertNumInRange = (label: string, value: number, min: number, max: number): void => {
  assertFiniteNumber(label, value);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
};

const HH_MM_RE = /^\d{2}:\d{2}$/u;

const assertHhMm = (label: string, value: string): void => {
  if (!HH_MM_RE.test(value)) {
    throw new Error(`${label} must be in HH:MM format (got "${value}")`);
  }
  const [h = NaN, m = NaN] = value.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`${label} has invalid hours/minutes (got "${value}")`);
  }
};

const assertConfigNumericBounds = (config: HomieConfig): void => {
  // Engine limiter / bucket sizes.
  assertIntInRange('engine.limiter.capacity', config.engine.limiter.capacity, 1, 1000);
  assertNumInRange('engine.limiter.refillPerSecond', config.engine.limiter.refillPerSecond, 0, 100);
  assertIntInRange(
    'engine.perChatLimiter.capacity',
    config.engine.perChatLimiter.capacity,
    1,
    1000,
  );
  assertNumInRange(
    'engine.perChatLimiter.refillPerSecond',
    config.engine.perChatLimiter.refillPerSecond,
    0,
    100,
  );
  assertIntInRange(
    'engine.perChatLimiter.staleAfterMs',
    config.engine.perChatLimiter.staleAfterMs,
    1,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange(
    'engine.perChatLimiter.sweepInterval',
    config.engine.perChatLimiter.sweepInterval,
    1,
    10_000,
  );
  assertIntInRange('engine.session.fetchLimit', config.engine.session.fetchLimit, 1, 2000);
  assertIntInRange(
    'engine.context.maxTokensDefault',
    config.engine.context.maxTokensDefault,
    256,
    200_000,
  );
  assertIntInRange(
    'engine.context.identityPromptMaxTokens',
    config.engine.context.identityPromptMaxTokens,
    64,
    200_000,
  );
  assertIntInRange(
    'engine.context.promptSkillsMaxTokens',
    config.engine.context.promptSkillsMaxTokens,
    64,
    200_000,
  );
  assertIntInRange(
    'engine.generation.reactiveMaxSteps',
    config.engine.generation.reactiveMaxSteps,
    1,
    200,
  );
  assertIntInRange(
    'engine.generation.proactiveMaxSteps',
    config.engine.generation.proactiveMaxSteps,
    1,
    200,
  );
  assertIntInRange('engine.generation.maxRegens', config.engine.generation.maxRegens, 0, 10);

  // Behavior timing.
  assertIntInRange('behavior.groupMaxChars', config.behavior.groupMaxChars, 1, 10_000);
  assertIntInRange('behavior.dmMaxChars', config.behavior.dmMaxChars, 1, 10_000);
  assertIntInRange('behavior.minDelayMs', config.behavior.minDelayMs, 0, 600_000);
  assertIntInRange('behavior.maxDelayMs', config.behavior.maxDelayMs, 0, 600_000);
  assertIntInRange('behavior.debounceMs', config.behavior.debounceMs, 0, 600_000);

  // Proactive budgets / timing.
  assertIntInRange(
    'proactive.heartbeatIntervalMs',
    config.proactive.heartbeatIntervalMs,
    1,
    86_400_000,
  );
  assertIntInRange('proactive.dm.maxPerDay', config.proactive.dm.maxPerDay, 0, 20);
  assertIntInRange('proactive.dm.maxPerWeek', config.proactive.dm.maxPerWeek, 0, 100);
  assertIntInRange(
    'proactive.dm.cooldownAfterUserMs',
    config.proactive.dm.cooldownAfterUserMs,
    0,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange('proactive.dm.pauseAfterIgnored', config.proactive.dm.pauseAfterIgnored, 0, 100);
  assertIntInRange('proactive.group.maxPerDay', config.proactive.group.maxPerDay, 0, 20);
  assertIntInRange('proactive.group.maxPerWeek', config.proactive.group.maxPerWeek, 0, 100);
  assertIntInRange(
    'proactive.group.cooldownAfterUserMs',
    config.proactive.group.cooldownAfterUserMs,
    0,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange(
    'proactive.group.pauseAfterIgnored',
    config.proactive.group.pauseAfterIgnored,
    0,
    100,
  );

  // Memory tuning.
  assertIntInRange('memory.contextBudgetTokens', config.memory.contextBudgetTokens, 1, 50_000);
  assertIntInRange('memory.capsule.maxTokens', config.memory.capsule.maxTokens, 1, 10_000);
  assertNumInRange('memory.decay.halfLifeDays', config.memory.decay.halfLifeDays, 0.1, 3650);
  assertIntInRange('memory.retrieval.rrfK', config.memory.retrieval.rrfK, 1, 500);
  assertNumInRange('memory.retrieval.ftsWeight', config.memory.retrieval.ftsWeight, 0, 10);
  assertNumInRange('memory.retrieval.vecWeight', config.memory.retrieval.vecWeight, 0, 10);
  assertNumInRange('memory.retrieval.recencyWeight', config.memory.retrieval.recencyWeight, 0, 10);
  assertIntInRange(
    'memory.feedback.finalizeAfterMs',
    config.memory.feedback.finalizeAfterMs,
    1,
    30 * 24 * 60 * 60_000,
  );
  assertNumInRange(
    'memory.feedback.successThreshold',
    config.memory.feedback.successThreshold,
    0,
    1,
  );
  assertNumInRange(
    'memory.feedback.failureThreshold',
    config.memory.feedback.failureThreshold,
    -1,
    0,
  );
  assertIntInRange(
    'memory.consolidation.intervalMs',
    config.memory.consolidation.intervalMs,
    1,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange(
    'memory.consolidation.maxEpisodesPerRun',
    config.memory.consolidation.maxEpisodesPerRun,
    1,
    1000,
  );
  assertIntInRange(
    'memory.consolidation.dirtyGroupLimit',
    config.memory.consolidation.dirtyGroupLimit,
    0,
    1000,
  );
  assertIntInRange(
    'memory.consolidation.dirtyPublicStyleLimit',
    config.memory.consolidation.dirtyPublicStyleLimit,
    0,
    1000,
  );
  assertIntInRange(
    'memory.consolidation.dirtyPersonLimit',
    config.memory.consolidation.dirtyPersonLimit,
    0,
    1000,
  );
};

export const loadHomieConfig = async (
  options: LoadHomieConfigOptions = {},
): Promise<LoadedHomieConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const env = (options.env ?? process.env) as HomieEnv;

  const configPath =
    options.configPath ?? env.HOMIE_CONFIG_PATH ?? (await findUp('homie.toml', cwd));
  if (!configPath) {
    throw new Error(
      'Could not find homie.toml (set HOMIE_CONFIG_PATH to override). Run `homie init` to create one.',
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
  const parsed = HomieConfigFileSchema.safeParse(tomlUnknown);
  if (!parsed.success) {
    throw new Error(`Invalid homie.toml: ${parsed.error.message}`);
  }

  const file = parsed.data;

  const provider = resolveProvider(
    env.HOMIE_MODEL_PROVIDER ?? file.model?.provider,
    env.HOMIE_MODEL_BASE_URL ?? file.model?.base_url,
  );

  const modelDefault =
    nonEmptyTrimmed(env.HOMIE_MODEL_DEFAULT) ??
    nonEmptyTrimmed(file.model?.default) ??
    nonEmptyTrimmed(defaults.model.models.default);
  const modelFast =
    nonEmptyTrimmed(env.HOMIE_MODEL_FAST) ?? nonEmptyTrimmed(file.model?.fast) ?? modelDefault;
  if (!modelDefault || !modelFast) {
    throw new Error('Model names must be non-empty (check model.default / model.fast).');
  }
  assertModelName('model.default', modelDefault);
  assertModelName('model.fast', modelFast);

  const timezone =
    env.HOMIE_TIMEZONE ??
    file.behavior?.timezone ??
    defaults.behavior.sleep.timezone ??
    getDefaultTimezone();

  if (!isValidIanaTimeZone(timezone)) {
    throw new Error(
      `Invalid time zone "${timezone}" (expected an IANA TZ like "America/Los_Angeles" or "UTC")`,
    );
  }

  const sleepEnabled =
    parseBoolEnvStrict(env.HOMIE_SLEEP_MODE, 'HOMIE_SLEEP_MODE') ??
    file.behavior?.sleep_mode ??
    defaults.behavior.sleep.enabled;

  const identityDir = await resolveDir(
    projectDir,
    env.HOMIE_IDENTITY_DIR ?? file.paths?.identity_dir ?? defaults.paths.identityDir,
    'identity_dir',
  );
  const skillsDir = await resolveDir(
    projectDir,
    env.HOMIE_SKILLS_DIR ?? file.paths?.skills_dir ?? defaults.paths.skillsDir,
    'skills_dir',
  );
  const dataDir = await resolveDir(
    projectDir,
    env.HOMIE_DATA_DIR ?? file.paths?.data_dir ?? defaults.paths.dataDir,
    'data_dir',
  );

  const restrictedEnabledForOperator =
    parseBoolEnvStrict(
      env.HOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR,
      'HOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR',
    ) ??
    file.tools?.restricted_enabled_for_operator ??
    defaults.tools.restricted.enabledForOperator;
  const restrictedAllowlist =
    parseCsvEnv(env.HOMIE_TOOLS_RESTRICTED_ALLOWLIST, 'HOMIE_TOOLS_RESTRICTED_ALLOWLIST') ??
    file.tools?.restricted_allowlist ??
    defaults.tools.restricted.allowlist;

  const dangerousEnabledForOperator =
    parseBoolEnvStrict(
      env.HOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR,
      'HOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR',
    ) ??
    file.tools?.dangerous_enabled_for_operator ??
    defaults.tools.dangerous.enabledForOperator;
  const dangerousAllowAll =
    parseBoolEnvStrict(env.HOMIE_TOOLS_DANGEROUS_ALLOW_ALL, 'HOMIE_TOOLS_DANGEROUS_ALLOW_ALL') ??
    file.tools?.dangerous_allow_all ??
    defaults.tools.dangerous.allowAll;
  const dangerousAllowlist =
    parseCsvEnv(env.HOMIE_TOOLS_DANGEROUS_ALLOWLIST, 'HOMIE_TOOLS_DANGEROUS_ALLOWLIST') ??
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

  const config: HomieConfig = {
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
          parseIntEnv(env.HOMIE_ENGINE_LIMITER_CAPACITY) ??
          file.engine?.limiter_capacity ??
          defaults.engine.limiter.capacity,
        refillPerSecond:
          parseNumberEnv(env.HOMIE_ENGINE_LIMITER_REFILL_PER_SECOND) ??
          file.engine?.limiter_refill_per_second ??
          defaults.engine.limiter.refillPerSecond,
      },
      perChatLimiter: {
        capacity:
          parseIntEnv(env.HOMIE_ENGINE_PER_CHAT_CAPACITY) ??
          file.engine?.per_chat_capacity ??
          defaults.engine.perChatLimiter.capacity,
        refillPerSecond:
          parseNumberEnv(env.HOMIE_ENGINE_PER_CHAT_REFILL_PER_SECOND) ??
          file.engine?.per_chat_refill_per_second ??
          defaults.engine.perChatLimiter.refillPerSecond,
        staleAfterMs:
          parseIntEnv(env.HOMIE_ENGINE_PER_CHAT_STALE_AFTER_MS) ??
          file.engine?.per_chat_stale_after_ms ??
          defaults.engine.perChatLimiter.staleAfterMs,
        sweepInterval:
          parseIntEnv(env.HOMIE_ENGINE_PER_CHAT_SWEEP_INTERVAL) ??
          file.engine?.per_chat_sweep_interval ??
          defaults.engine.perChatLimiter.sweepInterval,
      },
      session: {
        fetchLimit:
          parseIntEnv(env.HOMIE_ENGINE_SESSION_FETCH_LIMIT) ??
          file.engine?.session_fetch_limit ??
          defaults.engine.session.fetchLimit,
      },
      context: {
        maxTokensDefault:
          parseIntEnv(env.HOMIE_ENGINE_CONTEXT_MAX_TOKENS_DEFAULT) ??
          file.engine?.context_max_tokens_default ??
          defaults.engine.context.maxTokensDefault,
        identityPromptMaxTokens:
          parseIntEnv(env.HOMIE_ENGINE_IDENTITY_PROMPT_MAX_TOKENS) ??
          file.engine?.identity_prompt_max_tokens ??
          defaults.engine.context.identityPromptMaxTokens,
        promptSkillsMaxTokens:
          parseIntEnv(env.HOMIE_ENGINE_PROMPT_SKILLS_MAX_TOKENS) ??
          file.engine?.prompt_skills_max_tokens ??
          defaults.engine.context.promptSkillsMaxTokens,
      },
      generation: {
        reactiveMaxSteps:
          parseIntEnv(env.HOMIE_ENGINE_GENERATION_REACTIVE_MAX_STEPS) ??
          file.engine?.generation_reactive_max_steps ??
          defaults.engine.generation.reactiveMaxSteps,
        proactiveMaxSteps:
          parseIntEnv(env.HOMIE_ENGINE_GENERATION_PROACTIVE_MAX_STEPS) ??
          file.engine?.generation_proactive_max_steps ??
          defaults.engine.generation.proactiveMaxSteps,
        maxRegens:
          parseIntEnv(env.HOMIE_ENGINE_GENERATION_MAX_REGENS) ??
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
          parseIntEnv(env.HOMIE_MEMORY_RETRIEVAL_RRF_K) ??
          file.memory?.retrieval_rrf_k ??
          defaults.memory.retrieval.rrfK,
        ftsWeight:
          parseNumberEnv(env.HOMIE_MEMORY_RETRIEVAL_FTS_WEIGHT) ??
          file.memory?.retrieval_fts_weight ??
          defaults.memory.retrieval.ftsWeight,
        vecWeight:
          parseNumberEnv(env.HOMIE_MEMORY_RETRIEVAL_VEC_WEIGHT) ??
          file.memory?.retrieval_vec_weight ??
          defaults.memory.retrieval.vecWeight,
        recencyWeight:
          parseNumberEnv(env.HOMIE_MEMORY_RETRIEVAL_RECENCY_WEIGHT) ??
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
