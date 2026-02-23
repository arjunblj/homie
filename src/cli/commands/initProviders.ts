import * as p from '@clack/prompts';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { InitProvider, ProviderAvailability } from '../../llm/detect.js';
import { probeOllama } from '../../llm/ollama.js';
import { upsertEnvValue } from '../../util/env.js';
import { shortAddress } from '../../util/format.js';
import { openUrl } from '../../util/fs.js';
import {
  deriveMppWalletAddress,
  normalizeHttpUrl,
  normalizeMppPrivateKey,
} from '../../util/mpp.js';
import { cancelInit, failInit, guard, type InitEnv } from './initTypes.js';
import { MPP_FUND_DOCS_URL, MppVerifyError, verifyMppModelAccess } from './mppVerify.js';

export const probeOllamaBestEffort = async (): Promise<boolean> => {
  try {
    await probeOllama('http://localhost:11434/v1', fetch);
    return true;
  } catch (_err) {
    return false;
  }
};

export const listOllamaModelsBestEffort = async (): Promise<string[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    const models = (json as { models?: Array<{ name?: unknown }> }).models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m) => (typeof m?.name === 'string' ? m.name.trim() : ''))
      .filter((s) => Boolean(s));
  } catch (_err) {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

export const setDefaultModelsForProvider = async (
  selected: InitProvider,
): Promise<{ modelDefault: string; modelFast: string }> => {
  if (selected === 'claude-code') return { modelDefault: 'opus', modelFast: 'sonnet' };
  if (selected === 'codex-cli') return { modelDefault: 'gpt-5.3-codex', modelFast: 'gpt-5.2' };
  if (selected === 'anthropic')
    return { modelDefault: 'claude-sonnet-4-5', modelFast: 'claude-haiku-4-5' };
  if (selected === 'openrouter')
    return { modelDefault: 'openai/gpt-4o', modelFast: 'openai/gpt-4o-mini' };
  if (selected === 'openai') return { modelDefault: 'gpt-4o', modelFast: 'gpt-4o-mini' };
  // MPP proxy's most reliable LLM routes are the OpenAI-compatible endpoints.
  // Users can still opt into `/openrouter/v1` explicitly if they want provider-prefixed ids.
  if (selected === 'mpp') return { modelDefault: 'gpt-4o', modelFast: 'gpt-4o-mini' };
  const models = await listOllamaModelsBestEffort();
  const def = models[0] ?? 'llama3.2';
  return { modelDefault: def, modelFast: def };
};

export const isProviderUsable = (
  provider: InitProvider,
  availability: ProviderAvailability,
  env: NodeJS.ProcessEnv & {
    MPP_PRIVATE_KEY?: string | undefined;
    MPP_RPC_URL?: string | undefined;
    ANTHROPIC_API_KEY?: string | undefined;
    OPENROUTER_API_KEY?: string | undefined;
    OPENAI_API_KEY?: string | undefined;
  },
  ollamaDetected: boolean,
): boolean => {
  if (provider === 'mpp') {
    const key = normalizeMppPrivateKey(env.MPP_PRIVATE_KEY);
    const rpc = normalizeHttpUrl(env.MPP_RPC_URL ?? '');
    return (availability.hasMppPrivateKey || Boolean(key)) && Boolean(rpc);
  }
  if (provider === 'anthropic')
    return availability.hasAnthropicKey || Boolean(env.ANTHROPIC_API_KEY);
  if (provider === 'openrouter')
    return availability.hasOpenRouterKey || Boolean(env.OPENROUTER_API_KEY);
  if (provider === 'openai') return availability.hasOpenAiKey || Boolean(env.OPENAI_API_KEY);
  if (provider === 'claude-code') return availability.hasClaudeCodeCli;
  if (provider === 'codex-cli') return availability.hasCodexAuth;
  return ollamaDetected;
};

export const inferInitProviderFromConfig = (
  provider: { kind: string; baseUrl?: string | undefined },
  fallback: InitProvider,
): InitProvider => {
  if (provider.kind === 'anthropic') return 'anthropic';
  if (provider.kind === 'claude-code') return 'claude-code';
  if (provider.kind === 'codex-cli') return 'codex-cli';
  if (provider.kind === 'mpp') return 'mpp';
  if (provider.kind !== 'openai-compatible') return fallback;

  const baseUrl = provider.baseUrl?.toLowerCase() ?? '';
  if (baseUrl.includes('openrouter.ai')) return 'openrouter';
  if (baseUrl.includes('api.openai.com')) return 'openai';
  if (baseUrl.includes(':11434') || baseUrl.includes('ollama')) return 'ollama';
  return fallback;
};

export const resolveInterviewSelectionFromExistingConfig = (
  config: {
    model: {
      provider: { kind: string; baseUrl?: string | undefined };
      models: { default: string; fast: string };
    };
  },
  fallbackProvider: InitProvider,
): { provider: InitProvider; modelDefault: string; modelFast: string } => ({
  provider: inferInitProviderFromConfig(config.model.provider, fallbackProvider),
  modelDefault: config.model.models.default,
  modelFast: config.model.models.fast,
});

export async function runMppWalletFlow(
  env: InitEnv,
  envPath: string,
  availability: ProviderAvailability,
): Promise<{ shouldSkipInterview: boolean }> {
  let shouldSkipInterview = false;

  p.note(
    [
      'No API key required — requests paid from a wallet.',
      'Use a dedicated low-balance wallet for safety.',
      'You control the wallet; homie never holds your funds.',
      `Endpoint: ${pc.dim('https://mpp.tempo.xyz/openai/v1')}`,
    ].join('\n'),
    'MPP pay-per-use',
  );
  const rpcUrlInput = normalizeHttpUrl(
    String(
      guard(
        await p.text({
          message: 'Tempo RPC URL (MPP_RPC_URL)',
          initialValue: env.MPP_RPC_URL ?? 'https://rpc.mainnet.tempo.xyz',
        }),
      ),
    ),
  );
  if (!rpcUrlInput) {
    failInit('MPP provider requires MPP_RPC_URL.');
  }
  if (rpcUrlInput.includes('base.org') || rpcUrlInput.includes('mainnet.base')) {
    failInit('MPP_RPC_URL must point to Tempo, not Base.');
  }
  env.MPP_RPC_URL = rpcUrlInput;
  await upsertEnvValue(envPath, 'MPP_RPC_URL', rpcUrlInput);

  const walletSetup = guard(
    await p.select({
      message: 'Wallet setup',
      options: [
        {
          value: 'existing',
          label: 'Use existing MPP_PRIVATE_KEY',
          hint: availability.hasMppPrivateKey ? 'detected' : 'needs to be set',
        },
        { value: 'generate', label: 'Generate new dedicated wallet' },
        { value: 'later', label: 'Configure later' },
      ],
    }),
  );

  let walletReadyForVerification = false;
  if (walletSetup === 'generate') {
    const privKey = generatePrivateKey();
    const account = privateKeyToAccount(privKey);
    env.MPP_PRIVATE_KEY = privKey;
    availability.hasMppPrivateKey = true;
    await upsertEnvValue(envPath, 'MPP_PRIVATE_KEY', privKey);

    const addressText = account.address;
    const trunc = shortAddress(addressText);

    p.log.success(`Generated new wallet: ${pc.cyan(trunc)}`);
    p.log.success(`Saved ${pc.cyan('MPP_PRIVATE_KEY')} to ${pc.dim(envPath)}`);
    p.log.message('Funding QR:');
    try {
      qrcode.generate(`ethereum:${addressText}`, { small: true });
    } catch (_err) {
      // Terminal may not support QR rendering
    }
    p.log.message(`Full address (copy to fund on Tempo-supported network): ${pc.dim(addressText)}`);
    if (rpcUrlInput.includes('rpc.moderato.tempo.xyz')) {
      p.log.message(
        pc.dim(
          `Testnet faucet: cast rpc tempo_fundAddress ${addressText} --rpc-url https://rpc.moderato.tempo.xyz`,
        ),
      );
    }
    walletReadyForVerification = true;

    const openDocs = guard(
      await p.confirm({
        message: 'Open funding docs?',
        initialValue: false,
      }),
    );
    if (openDocs) {
      const opened = await openUrl(MPP_FUND_DOCS_URL);
      if (opened) p.log.info('Opened docs.');
      else p.log.warn('Could not open browser automatically.');
    }
  } else if (walletSetup === 'existing') {
    const existingKey = env.MPP_PRIVATE_KEY?.trim() ?? '';
    if (!existingKey) {
      p.log.warn('MPP_PRIVATE_KEY is not set yet. Add it in .env to continue.');
    } else if (!normalizeMppPrivateKey(existingKey)) {
      p.log.warn('MPP_PRIVATE_KEY format looks invalid (expected 0x + 64 hex chars).');
    } else {
      const address = deriveMppWalletAddress(existingKey);
      if (address) {
        p.log.success(`Using wallet: ${pc.cyan(shortAddress(address))}`);
        p.log.message(`Full address: ${pc.dim(address)}`);
        walletReadyForVerification = true;
      } else {
        p.log.warn('MPP_PRIVATE_KEY could not be decoded. Replace it and try again.');
      }
    }
  } else {
    shouldSkipInterview = true;
    p.log.warn('Wallet setup deferred. Interview is skipped until wallet funding is verified.');
  }

  if (walletReadyForVerification) {
    const defaults = await setDefaultModelsForProvider('mpp');
    while (true) {
      const fundingAction = guard(
        await p.select({
          message: 'Wallet readiness before interview',
          options: [
            {
              value: 'check',
              label: 'Check funding now',
              hint: 'recommended',
            },
            {
              value: 'skip',
              label: 'Skip interview for now',
              hint: 'continue setup without AI generation',
            },
            {
              value: 'cancel',
              label: 'Cancel setup',
            },
          ],
          initialValue: 'check',
        }),
      );
      if (fundingAction === 'cancel') cancelInit();
      if (fundingAction === 'skip') {
        shouldSkipInterview = true;
        p.log.warn(
          'Skipping interview until the wallet is funded. You can rerun `homie init` later.',
        );
        break;
      }

      const verifySpinner = p.spinner();
      verifySpinner.start('Verifying MPP wallet by running a tiny model request...');
      try {
        await verifyMppModelAccess({
          env,
          model: defaults.modelFast,
          timeoutMs: 12_000,
        });
        verifySpinner.stop('Wallet looks funded and ready');
        break;
      } catch (err) {
        verifySpinner.stop('Wallet not ready yet');
        if (err instanceof MppVerifyError) {
          p.log.warn(`MPP check failed [${err.failure.code}]: ${err.failure.detail}`);
          p.log.message(err.failure.nextStep);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          p.log.warn(`MPP check failed: ${msg}`);
          p.log.message('Fund the wallet, then choose "Check funding now" again.');
        }
      }
    }
  }

  return { shouldSkipInterview };
}
