import type { OpenhomieProvider } from './types.js';

export interface OpenhomieEnv extends NodeJS.ProcessEnv {
  OPENHOMIE_CONFIG_PATH?: string;
  OPENHOMIE_MODEL_PROVIDER?: string;
  OPENHOMIE_MODEL_BASE_URL?: string;
  OPENHOMIE_MODEL_DEFAULT?: string;
  OPENHOMIE_MODEL_FAST?: string;
  OPENHOMIE_TIMEZONE?: string;
  OPENHOMIE_SLEEP_MODE?: string;
  OPENHOMIE_IDENTITY_DIR?: string;
  OPENHOMIE_SKILLS_DIR?: string;
  OPENHOMIE_DATA_DIR?: string;
  OPENHOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR?: string;
  OPENHOMIE_TOOLS_RESTRICTED_ALLOWLIST?: string;
  OPENHOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR?: string;
  OPENHOMIE_TOOLS_DANGEROUS_ALLOW_ALL?: string;
  OPENHOMIE_TOOLS_DANGEROUS_ALLOWLIST?: string;
  OPENHOMIE_ENGINE_LIMITER_CAPACITY?: string;
  OPENHOMIE_ENGINE_LIMITER_REFILL_PER_SECOND?: string;
  OPENHOMIE_ENGINE_PER_CHAT_CAPACITY?: string;
  OPENHOMIE_ENGINE_PER_CHAT_REFILL_PER_SECOND?: string;
  OPENHOMIE_ENGINE_PER_CHAT_STALE_AFTER_MS?: string;
  OPENHOMIE_ENGINE_PER_CHAT_SWEEP_INTERVAL?: string;
  OPENHOMIE_ENGINE_SESSION_FETCH_LIMIT?: string;
  OPENHOMIE_ENGINE_CONTEXT_MAX_TOKENS_DEFAULT?: string;
  OPENHOMIE_ENGINE_IDENTITY_PROMPT_MAX_TOKENS?: string;
  OPENHOMIE_ENGINE_PROMPT_SKILLS_MAX_TOKENS?: string;
  OPENHOMIE_ENGINE_GENERATION_REACTIVE_MAX_STEPS?: string;
  OPENHOMIE_ENGINE_GENERATION_PROACTIVE_MAX_STEPS?: string;
  OPENHOMIE_ENGINE_GENERATION_MAX_REGENS?: string;
  OPENHOMIE_MEMORY_RETRIEVAL_RRF_K?: string;
  OPENHOMIE_MEMORY_RETRIEVAL_FTS_WEIGHT?: string;
  OPENHOMIE_MEMORY_RETRIEVAL_VEC_WEIGHT?: string;
  OPENHOMIE_MEMORY_RETRIEVAL_RECENCY_WEIGHT?: string;
}

const parseBoolEnv = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return undefined;
};

export const parseBoolEnvStrict = (
  value: string | undefined,
  label: string,
): boolean | undefined => {
  const parsed = parseBoolEnv(value);
  if (value !== undefined && parsed === undefined) {
    throw new Error(`Invalid ${label}: expected true/false/1/0/yes/no/on/off`);
  }
  return parsed;
};

export const parseCsvEnv = (value: string | undefined, label: string): string[] | undefined => {
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

export const parseNumberEnv = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
};

export const parseIntEnv = (value: string | undefined): number | undefined => {
  const n = parseNumberEnv(value);
  if (n === undefined) return undefined;
  return Math.trunc(n);
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

export const resolveProvider = (
  providerRaw: string | undefined,
  baseUrlRaw?: string,
): OpenhomieProvider => {
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

export const nonEmptyTrimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v : undefined;
};

export const assertModelName = (label: string, value: string): void => {
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

export const isValidIanaTimeZone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch (_err) {
    return false;
  }
};

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export const normalizeToolAllowlist = (label: string, values: readonly string[]): string[] => {
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
