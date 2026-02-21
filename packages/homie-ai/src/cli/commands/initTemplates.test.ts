import { describe, expect, test } from 'bun:test';
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
  });

  test('produces valid TOML for claude-code provider', () => {
    const toml = buildInitConfigToml('claude-code', 'claude-3.5-sonnet', 'claude-3-haiku');
    expect(toml).toContain('provider = "claude-code"');
    expect(toml).toContain('Claude Code CLI');
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
