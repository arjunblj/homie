import { describe, expect, test } from 'bun:test';

import { detectProviderAvailability, recommendInitProvider } from './detect.js';

describe('detectProviderAvailability', () => {
  test('detects API keys and MPP key', async () => {
    const out = await detectProviderAvailability(
      {
        ANTHROPIC_API_KEY: 'a',
        OPENROUTER_API_KEY: 'or',
        OPENAI_API_KEY: 'oa',
        MPP_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
      } as NodeJS.ProcessEnv,
      undefined,
      async () => ({ code: 1, stdout: '' }),
    );

    expect(out.hasAnthropicKey).toBe(true);
    expect(out.hasOpenRouterKey).toBe(true);
    expect(out.hasOpenAiKey).toBe(true);
    expect(out.hasMppPrivateKey).toBe(true);
  });

  test('does not report malformed MPP key as available', async () => {
    const out = await detectProviderAvailability(
      {
        MPP_PRIVATE_KEY: '0xabc',
      } as NodeJS.ProcessEnv,
      undefined,
      async () => ({ code: 1, stdout: '' }),
    );
    expect(out.hasMppPrivateKey).toBe(false);
  });

  test('detects claude and codex auth via CLI probes', async () => {
    const out = await detectProviderAvailability(
      {} as NodeJS.ProcessEnv,
      undefined,
      async (command, args) => {
        if (command === 'claude' && args[0] === '--version') return { code: 0, stdout: '1.0.0' };
        if (command === 'codex' && args[0] === '--version') return { code: 0, stdout: '0.9.0' };
        if (command === 'codex' && args[0] === 'login' && args[1] === 'status') {
          return { code: 0, stdout: 'logged in' };
        }
        return { code: 1, stdout: '' };
      },
    );
    expect(out.hasClaudeCodeCli).toBe(true);
    expect(out.hasCodexCli).toBe(true);
    expect(out.hasCodexAuth).toBe(true);
  });
});

describe('recommendInitProvider', () => {
  test('prefers claude-code when installed', () => {
    const provider = recommendInitProvider({
      hasClaudeCodeCli: true,
      hasCodexCli: true,
      hasCodexAuth: true,
      hasAnthropicKey: true,
      hasOpenRouterKey: true,
      hasOpenAiKey: true,
      hasMppPrivateKey: true,
    });
    expect(provider).toBe('claude-code');
  });

  test('prefers openrouter when multiple keys exist', () => {
    const provider = recommendInitProvider({
      hasClaudeCodeCli: false,
      hasCodexCli: false,
      hasCodexAuth: false,
      hasAnthropicKey: true,
      hasOpenRouterKey: true,
      hasOpenAiKey: true,
      hasMppPrivateKey: true,
    });
    expect(provider).toBe('openrouter');
  });

  test('falls back to mpp before ollama when wallet key exists', () => {
    const provider = recommendInitProvider(
      {
        hasClaudeCodeCli: false,
        hasCodexCli: false,
        hasCodexAuth: false,
        hasAnthropicKey: false,
        hasOpenRouterKey: false,
        hasOpenAiKey: false,
        hasMppPrivateKey: true,
      },
      { ollamaDetected: true },
    );
    expect(provider).toBe('mpp');
  });

  test('returns null when nothing is available', () => {
    const provider = recommendInitProvider({
      hasClaudeCodeCli: false,
      hasCodexCli: false,
      hasCodexAuth: false,
      hasAnthropicKey: false,
      hasOpenRouterKey: false,
      hasOpenAiKey: false,
      hasMppPrivateKey: false,
    });
    expect(provider).toBeNull();
  });
});
