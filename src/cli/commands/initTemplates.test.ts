import { describe, expect, test } from 'bun:test';
import { parse as parseToml } from 'smol-toml';
import { buildEnvExampleLines, buildInitConfigToml } from './initTemplates.js';

describe('buildInitConfigToml', () => {
  test('produces valid TOML for mpp provider', () => {
    const toml = buildInitConfigToml(
      'mpp',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-haiku',
    );
    expect(toml).toContain('provider = "mpp"');
    expect(toml).toContain('base_url = "https://mpp.tempo.xyz"');
    expect(toml).toContain('default = "anthropic/claude-3.5-sonnet"');
    expect(toml).toContain('fast = "anthropic/claude-3-haiku"');
    expect(toml).toContain('[tools]');
    expect(toml).toContain('dangerous_allow_all = false');
  });

  test('produces valid TOML for claude-code provider', () => {
    const toml = buildInitConfigToml('claude-code', 'claude-3.5-sonnet', 'claude-3-haiku');
    expect(toml).toContain('provider = "claude-code"');
    expect(toml).toContain('Claude Code CLI');
  });

  test('escapes model names with quotes, slashes, and newlines', () => {
    const toml = buildInitConfigToml('openai', 'model"with\\chars', 'fast\nmodel');
    const parsed = parseToml(toml) as {
      model?: { default?: string; fast?: string };
    };
    expect(parsed.model?.default).toBe('model"with\\chars');
    expect(parsed.model?.fast).toBe('fast\nmodel');
  });
});

describe('buildEnvExampleLines', () => {
  test('includes telegram section when enabled', () => {
    const lines = buildEnvExampleLines(true, false);
    const joined = lines.join('\n');
    expect(joined).toContain('TELEGRAM_BOT_TOKEN=');
    expect(joined).not.toContain('# TELEGRAM_BOT_TOKEN=');
  });

  test('comments out telegram when disabled', () => {
    const lines = buildEnvExampleLines(false, false);
    const joined = lines.join('\n');
    expect(joined).toContain('# TELEGRAM_BOT_TOKEN=');
  });
});
