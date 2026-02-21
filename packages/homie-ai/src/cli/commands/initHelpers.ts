import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultConfig } from '../../config/defaults.js';
import type { HomieConfig, HomieProvider } from '../../config/types.js';
import type { InitProvider } from '../../llm/detect.js';
import { normalizeHttpUrl } from '../../util/mpp.js';

interface MakeTempConfigOptions {
  baseUrl?: string | undefined;
}

const mapInitProviderToHomieProvider = (
  provider: InitProvider,
  options?: MakeTempConfigOptions,
): HomieProvider => {
  if (provider === 'openrouter') {
    return { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' };
  }
  if (provider === 'openai') {
    return { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };
  }
  if (provider === 'ollama') {
    return { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' };
  }
  if (provider === 'mpp') {
    const normalized = options?.baseUrl ? normalizeHttpUrl(options.baseUrl) : '';
    return { kind: 'mpp', baseUrl: normalized || 'https://mpp.tempo.xyz' };
  }
  if (provider === 'anthropic') return { kind: 'anthropic' };
  if (provider === 'claude-code') return { kind: 'claude-code' };
  return { kind: 'codex-cli' };
};

export const makeTempConfig = (
  provider: InitProvider,
  modelDefault: string,
  modelFast: string,
  options?: MakeTempConfigOptions,
): HomieConfig => {
  const projectDir = path.join(tmpdir(), 'homie-temp');
  const base = createDefaultConfig(projectDir);
  return {
    ...base,
    model: {
      provider: mapInitProviderToHomieProvider(provider, options),
      models: { default: modelDefault, fast: modelFast },
    },
    behavior: {
      ...base.behavior,
      sleep: { ...base.behavior.sleep, enabled: false },
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    },
    proactive: {
      ...base.proactive,
      enabled: false,
    },
    memory: {
      ...base.memory,
      enabled: false,
      capsule: { ...base.memory.capsule, enabled: false },
      decay: { ...base.memory.decay, enabled: false },
      feedback: { ...base.memory.feedback, enabled: false },
      consolidation: { ...base.memory.consolidation, enabled: false },
    },
    tools: {
      restricted: { enabledForOperator: false, allowlist: [] },
      dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
    },
    paths: {
      projectDir,
      identityDir: path.join(projectDir, 'identity'),
      skillsDir: path.join(projectDir, 'skills'),
      dataDir: path.join(projectDir, 'data'),
    },
  };
};
