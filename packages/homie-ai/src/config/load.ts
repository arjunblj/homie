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
  HOMIE_TOOLS_SHELL?: string;
}

const parseBoolEnv = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return undefined;
};

const resolveDir = (projectDir: string, maybeRelative: string): string => {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(projectDir, maybeRelative);
};

const resolveProvider = (providerRaw: string | undefined, baseUrlRaw?: string): HomieProvider => {
  const provider = (providerRaw ?? 'anthropic').toLowerCase();
  if (provider === 'anthropic') return { kind: 'anthropic' };

  if (provider === 'openrouter')
    return { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' };
  if (provider === 'ollama')
    return { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' };
  if (provider === 'openai-compatible' || provider === 'openai_compatible') {
    return baseUrlRaw
      ? { kind: 'openai-compatible', baseUrl: baseUrlRaw }
      : { kind: 'openai-compatible' };
  }

  return baseUrlRaw
    ? { kind: 'openai-compatible', baseUrl: baseUrlRaw }
    : { kind: 'openai-compatible' };
};

export const loadHomieConfig = async (
  options: LoadHomieConfigOptions = {},
): Promise<LoadedHomieConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const env = (options.env ?? process.env) as HomieEnv;

  const configPath =
    options.configPath ?? env.HOMIE_CONFIG_PATH ?? (await findUp('homie.toml', cwd));
  if (!configPath) {
    throw new Error('Could not find homie.toml (set HOMIE_CONFIG_PATH to override)');
  }

  const projectDir = path.dirname(configPath);
  const defaults = createDefaultConfig(projectDir);

  const tomlText = await readTextFile(configPath);
  const tomlUnknown = parseToml(tomlText) as unknown;
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
    env.HOMIE_MODEL_DEFAULT ?? file.model?.default ?? defaults.model.models.default;
  const modelFast = env.HOMIE_MODEL_FAST ?? file.model?.fast ?? modelDefault;

  const timezone =
    env.HOMIE_TIMEZONE ??
    file.behavior?.timezone ??
    defaults.behavior.sleep.timezone ??
    getDefaultTimezone();

  const sleepEnabled =
    parseBoolEnv(env.HOMIE_SLEEP_MODE) ??
    file.behavior?.sleep_mode ??
    defaults.behavior.sleep.enabled;

  const identityDir = resolveDir(
    projectDir,
    env.HOMIE_IDENTITY_DIR ?? file.paths?.identity_dir ?? defaults.paths.identityDir,
  );
  const skillsDir = resolveDir(
    projectDir,
    env.HOMIE_SKILLS_DIR ?? file.paths?.skills_dir ?? defaults.paths.skillsDir,
  );
  const dataDir = resolveDir(
    projectDir,
    env.HOMIE_DATA_DIR ?? file.paths?.data_dir ?? defaults.paths.dataDir,
  );

  const shellEnabled =
    parseBoolEnv(env.HOMIE_TOOLS_SHELL) ?? file.tools?.shell ?? defaults.tools.shell;

  const config: HomieConfig = {
    schemaVersion: file.schema_version ?? defaults.schemaVersion,
    model: {
      provider,
      models: {
        default: modelDefault,
        fast: modelFast,
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
      maxPerDay: file.proactive?.max_per_day ?? defaults.proactive.maxPerDay,
      maxPerWeek: file.proactive?.max_per_week ?? defaults.proactive.maxPerWeek,
      cooldownAfterUserMs:
        file.proactive?.cooldown_after_user_ms ?? defaults.proactive.cooldownAfterUserMs,
      pauseAfterIgnored:
        file.proactive?.pause_after_ignored ?? defaults.proactive.pauseAfterIgnored,
    },
    tools: {
      shell: shellEnabled,
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

  return { configPath, config };
};
