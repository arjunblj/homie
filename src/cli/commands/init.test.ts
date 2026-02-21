import { describe, expect, test } from 'bun:test';
import {
  inferInitProviderFromConfig,
  resolveInterviewSelectionFromExistingConfig,
} from './init.js';
import { makeTempConfig } from './initHelpers.js';

describe('homie init helpers', () => {
  test('makeTempConfig builds a valid config stub', () => {
    const cfg = makeTempConfig('mpp', 'default-model', 'fast-model');
    expect(cfg.model.provider.kind).toBe('mpp');
    if (cfg.model.provider.kind === 'mpp') {
      expect(cfg.model.provider.baseUrl).toBe('https://mpp.tempo.xyz');
    }
    expect(cfg.model.models.default).toBe('default-model');
    expect(cfg.model.models.fast).toBe('fast-model');
  });

  test('makeTempConfig supports mpp baseUrl override', () => {
    const cfg = makeTempConfig('mpp', 'default-model', 'fast-model', {
      baseUrl: 'https://example-mpp.local',
    });
    if (cfg.model.provider.kind === 'mpp') {
      expect(cfg.model.provider.baseUrl).toBe('https://example-mpp.local');
    }
  });

  test('infers openrouter from existing openai-compatible baseUrl', () => {
    const provider = inferInitProviderFromConfig(
      { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
      'anthropic',
    );
    expect(provider).toBe('openrouter');
  });

  test('keeps fallback when existing provider cannot be inferred', () => {
    const provider = inferInitProviderFromConfig(
      { kind: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
      'codex-cli',
    );
    expect(provider).toBe('codex-cli');
  });

  test('uses existing provider and models for interview selection', () => {
    const selected = resolveInterviewSelectionFromExistingConfig(
      {
        model: {
          provider: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
          models: { default: 'openai/gpt-4.1', fast: 'openai/gpt-4.1-mini' },
        },
      },
      'anthropic',
    );
    expect(selected.provider).toBe('openrouter');
    expect(selected.modelDefault).toBe('openai/gpt-4.1');
    expect(selected.modelFast).toBe('openai/gpt-4.1-mini');
  });
});
