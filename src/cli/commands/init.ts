import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import * as p from '@clack/prompts';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createBackend } from '../../backend/factory.js';
import {
  sendTelegramTestMessage,
  tryFetchSignalLinkUri,
  validateTelegramToken,
  verifySignalDaemonHealth,
} from '../../channels/validate.js';
import { loadOpenhomieConfig } from '../../config/load.js';
import { getIdentityPaths } from '../../identity/load.js';
import { BackendAdapter } from '../../interview/backendAdapter.js';
import {
  generateIdentity,
  type IdentityDraft,
  nextInterviewQuestion,
  refineIdentity,
} from '../../interview/index.js';
import {
  detectProviderAvailability,
  type InitProvider,
  type ProviderAvailability,
  recommendInitProvider,
} from '../../llm/detect.js';
import { probeOllama } from '../../llm/ollama.js';
import { upsertEnvValue } from '../../util/env.js';
import { shortAddress } from '../../util/format.js';
import { fileExists, openUrl } from '../../util/fs.js';
import {
  deriveMppWalletAddress,
  normalizeHttpUrl,
  normalizeMppPrivateKey,
} from '../../util/mpp.js';
import {
  fundAgentTestnet,
  generateAgentRuntimeWallet,
  isValidAgentRuntimePrivateKey,
  OPENHOMIE_AGENT_KEY_ENV,
} from '../../wallet/runtime.js';
import type { GlobalOpts } from '../args.js';
import { writeInitArtifacts } from './initArtifacts.js';
import { formatIdentityPreview, printDetectionSummary } from './initFormat.js';
import { makeTempConfig } from './initHelpers.js';
import { type InterviewOperatorProfile, scoreIdentityDraft } from './initQuality.js';
import { MppVerifyError, verifyMppModelAccess } from './mppVerify.js';

const cancelInit = (msg?: string): never => {
  p.cancel(msg ?? 'Setup cancelled.');
  process.exit(0);
};

const failInit = (msg: string): never => {
  p.cancel(msg);
  process.exit(1);
};

const guard = <T>(value: T | symbol): T => {
  if (p.isCancel(value)) cancelInit();
  return value as T;
};

const MPP_DOCS_URL = 'https://mpp.tempo.xyz/llms.txt';
const SIGNAL_DOCKER_COMMAND = 'docker run --rm -p 8080:8080 bbernhard/signal-cli-rest-api:latest';

const signalDaemonHint = (reason: string): string => {
  const low = reason.toLowerCase();
  if (low.includes('econnrefused') || low.includes('fetch failed')) {
    return `Start the daemon first, e.g. ${SIGNAL_DOCKER_COMMAND}`;
  }
  if (low.includes('timed out') || low.includes('abort')) {
    return 'The daemon is slow/unreachable. Check network and retry with the same URL.';
  }
  if (low.includes('http 404')) {
    return 'The URL is reachable but endpoint is wrong. Verify the daemon base URL.';
  }
  return 'Verify daemon URL, process status, and port mapping, then retry.';
};

const createReasoningReporter = (
  label: string,
): {
  onReasoningDelta: (delta: string) => void;
  stop: () => void;
} => {
  let raw = '';
  let printed = '';
  let timer: ReturnType<typeof setInterval> | null = null;
  const render = (): void => {
    const compact = raw.replace(/\s+/gu, ' ').trim();
    if (!compact || compact === printed) return;
    printed = compact;
    const preview = compact.length > 110 ? `${compact.slice(0, 110).trimEnd()}...` : compact;
    process.stdout.write(`\x1b[2K\r${pc.dim(`  -> ${label}: ${preview}`)}`);
  };
  return {
    onReasoningDelta: (delta: string) => {
      if (!delta) return;
      raw += delta;
      if (timer) return;
      timer = setInterval(render, 180);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!raw.trim()) return;
      render();
      process.stdout.write('\n');
    },
  };
};

const askOptionalRichField = async (params: {
  message: string;
  placeholder?: string | undefined;
}): Promise<string | undefined> => {
  const raw = String(
    guard(
      await p.text({
        message: params.message,
        ...(params.placeholder ? { placeholder: params.placeholder } : {}),
      }),
    ),
  ).trim();
  if (!raw || raw.toLowerCase() === 'skip') return undefined;
  return raw;
};

const buildOperatorContextBlock = (
  profile: InterviewOperatorProfile | undefined,
  friendName: string,
): string => {
  if (!profile) return `FriendName: ${friendName}`;
  const lines = [
    `FriendName: ${friendName}`,
    `OperatorName: ${profile.operatorName ?? '(unknown)'}`,
    `RelationshipDynamic: ${profile.relationshipDynamic ?? '(unspecified)'}`,
    `BiographyDetails: ${profile.biographyDetails ?? '(unspecified)'}`,
    `TechnicalDetails: ${profile.technicalDetails ?? '(unspecified)'}`,
    `ConsistencyReferences: ${profile.consistencyReferences ?? '(none)'}`,
  ];
  return lines.join('\n');
};

const probeOllamaBestEffort = async (): Promise<boolean> => {
  try {
    await probeOllama('http://localhost:11434/v1', fetch);
    return true;
  } catch (_err) {
    return false;
  }
};

const listOllamaModelsBestEffort = async (): Promise<string[]> => {
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

const setDefaultModelsForProvider = async (
  selected: InitProvider,
): Promise<{ modelDefault: string; modelFast: string }> => {
  if (selected === 'claude-code') return { modelDefault: 'opus', modelFast: 'sonnet' };
  if (selected === 'codex-cli') return { modelDefault: 'gpt-5.3-codex', modelFast: 'gpt-5.2' };
  if (selected === 'anthropic')
    return { modelDefault: 'claude-sonnet-4-5', modelFast: 'claude-haiku-4-5' };
  if (selected === 'openrouter')
    return { modelDefault: 'openai/gpt-4o', modelFast: 'openai/gpt-4o-mini' };
  if (selected === 'openai') return { modelDefault: 'gpt-4o', modelFast: 'gpt-4o-mini' };
  if (selected === 'mpp') return { modelDefault: 'openai/gpt-4o', modelFast: 'openai/gpt-4o-mini' };
  const models = await listOllamaModelsBestEffort();
  const def = models[0] ?? 'llama3.2';
  return { modelDefault: def, modelFast: def };
};

const isProviderUsable = (
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

interface InitEnv extends NodeJS.ProcessEnv {
  OPENHOMIE_AGENT_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MPP_PRIVATE_KEY?: string;
  MPP_RPC_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OPERATOR_USER_ID?: string;
  SIGNAL_DAEMON_URL?: string;
  SIGNAL_NUMBER?: string;
  SIGNAL_OPERATOR_NUMBER?: string;
}

export async function runInitCommand(opts: GlobalOpts): Promise<void> {
  const configPath = opts.configPath ?? path.join(process.cwd(), 'homie.toml');
  const interactive =
    opts.interactive && !opts.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const configExists = await fileExists(configPath);

  const env = process.env as InitEnv;

  const projectDir = path.dirname(configPath);
  const identityDir = path.join(projectDir, 'identity');
  const skillsDir = path.join(projectDir, 'skills');
  const dataDir = path.join(projectDir, 'data');
  const envPath = path.join(projectDir, '.env');
  const idPaths = getIdentityPaths(identityDir);
  await mkdir(projectDir, { recursive: true });

  let shouldWriteConfig = !configExists || opts.force;
  let usedQuickStart = !interactive;
  let provider: InitProvider = 'anthropic';
  let modelDefault = 'claude-sonnet-4-5';
  let modelFast = 'claude-haiku-4-5';
  let wantsTelegram = false;
  let wantsSignal = false;
  let identityDraft: IdentityDraft | null = null;
  let operatorProfile: InterviewOperatorProfile | undefined;
  let overwriteIdentityFromInterview = false;
  let shouldSkipInterview = false;
  let providerVerifiedViaInterview = false;
  let agentWalletAddress: string | undefined;
  let agentWalletGenerated = false;
  let agentWalletFundAttempted = false;

  // ── Detection (with spinner) ──────────────────────────────────
  const spin = p.spinner();
  if (interactive) spin.start('Detecting available providers...');

  const [availability, ollamaDetected] = await Promise.all([
    detectProviderAvailability(env, { timeoutMs: 3_000 }),
    probeOllamaBestEffort(),
  ]);
  const recommendedProvider = recommendInitProvider(availability, { ollamaDetected });
  if (recommendedProvider) {
    provider = recommendedProvider;
  }

  if (interactive) {
    const count = [
      availability.hasClaudeCodeCli,
      availability.hasCodexCli,
      availability.hasAnthropicKey,
      availability.hasOpenRouterKey,
      availability.hasOpenAiKey,
      availability.hasMppPrivateKey,
      ollamaDetected,
    ].filter(Boolean).length;
    spin.stop(`Detected ${count} provider${count === 1 ? '' : 's'}`);
  }

  // ── Interactive wizard ────────────────────────────────────────
  if (interactive) {
    p.intro(pc.bold('homie init'));

    // Existing config gate
    if (configExists && !opts.force) {
      p.log.warn(`Found existing config at ${pc.dim(configPath)}`);
      const existingAction = guard(
        await p.select({
          message: 'What should init do?',
          options: [
            { value: 'keep', label: 'Keep config', hint: 'only fill missing support files' },
            { value: 'reconfigure', label: 'Reconfigure', hint: 'rewrite homie.toml' },
            { value: 'cancel', label: 'Cancel' },
          ],
          initialValue: 'keep',
        }),
      );
      if (existingAction === 'cancel') cancelInit();
      shouldWriteConfig = existingAction === 'reconfigure';
      if (!shouldWriteConfig) {
        try {
          const loaded = await loadOpenhomieConfig({ cwd: projectDir, configPath, env });
          const existingSelection = resolveInterviewSelectionFromExistingConfig(
            loaded.config,
            recommendedProvider ?? provider,
          );
          provider = existingSelection.provider;
          modelDefault = existingSelection.modelDefault;
          modelFast = existingSelection.modelFast;
          usedQuickStart = false;
        } catch (_err) {
          p.log.warn(
            'Could not read existing model settings; using detected defaults for interview.',
          );
        }
      }
    }

    // Provider configuration
    if (shouldWriteConfig) {
      printDetectionSummary(availability, ollamaDetected);

      provider = guard(
        await p.select({
          message: 'Model provider',
          options: [
            {
              value: 'claude-code' as InitProvider,
              label: 'Claude Code CLI',
              hint: availability.hasClaudeCodeCli ? 'session detected' : 'not detected',
            },
            {
              value: 'codex-cli' as InitProvider,
              label: 'Codex CLI',
              hint: availability.hasCodexCli
                ? availability.hasCodexAuth
                  ? 'logged in'
                  : 'login required'
                : 'not detected',
            },
            {
              value: 'openrouter' as InitProvider,
              label: 'OpenRouter',
              hint: availability.hasOpenRouterKey ? 'key detected' : 'needs OPENROUTER_API_KEY',
            },
            {
              value: 'anthropic' as InitProvider,
              label: 'Anthropic',
              hint: availability.hasAnthropicKey ? 'key detected' : 'needs ANTHROPIC_API_KEY',
            },
            {
              value: 'openai' as InitProvider,
              label: 'OpenAI',
              hint: availability.hasOpenAiKey ? 'key detected' : 'needs OPENAI_API_KEY',
            },
            {
              value: 'mpp' as InitProvider,
              label: 'MPP stablecoin payments',
              hint: availability.hasMppPrivateKey
                ? 'wallet key detected'
                : 'pay-per-use, needs MPP_PRIVATE_KEY',
            },
            {
              value: 'ollama' as InitProvider,
              label: 'Ollama (local)',
              hint: ollamaDetected ? 'running' : 'not detected',
            },
          ],
          initialValue: recommendedProvider ?? provider,
        }),
      );
      usedQuickStart = Boolean(recommendedProvider) && provider === recommendedProvider;

      if (provider === 'openrouter' || provider === 'openai' || provider === 'mpp') {
        if (provider === 'mpp') {
          p.note(
            [
              'No API key required — requests paid from a wallet.',
              'Use a dedicated low-balance wallet for safety.',
              'You control the wallet; homie never holds your funds.',
              `Endpoint: ${pc.dim('https://mpp.tempo.xyz/openrouter/v1')}`,
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
            p.log.message(
              `Full address (copy to fund on Tempo-supported network): ${pc.dim(addressText)}`,
            );
            walletReadyForVerification = true;

            const openDocs = guard(
              await p.confirm({
                message: 'Open MPP docs for funding instructions?',
                initialValue: false,
              }),
            );
            if (openDocs) {
              const opened = await openUrl(MPP_DOCS_URL);
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
            p.log.warn(
              'Wallet setup deferred. Interview is skipped until wallet funding is verified.',
            );
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
        }
        const prefix = provider === 'mpp' ? 'MPP model (OpenRouter route)' : `${provider} model`;
        const defaults = await setDefaultModelsForProvider(provider);
        modelDefault = guard(
          await p.text({
            message: `${prefix} — default`,
            initialValue: defaults.modelDefault,
          }),
        );
        modelFast = guard(
          await p.text({
            message: `${prefix} — fast`,
            initialValue: defaults.modelFast,
          }),
        );
      } else if (provider === 'ollama') {
        const models = await listOllamaModelsBestEffort();
        const hint = models.length ? ` (found: ${models.slice(0, 5).join(', ')})` : '';
        const def = models[0] ?? 'llama3.2';
        modelDefault = guard(
          await p.text({
            message: `Ollama model${hint}`,
            initialValue: def,
          }),
        );
        modelFast = modelDefault;
      } else {
        const defaults = await setDefaultModelsForProvider(provider);
        modelDefault = defaults.modelDefault;
        modelFast = defaults.modelFast;
      }

      // ── Channel setup ──────────────────────────────────────────────
      p.log.step(pc.bold('Connect a chat platform'));
      p.log.message(
        pc.dim(
          [
            "Your friend lives on Telegram or Signal — that's where people actually chat.",
            'The CLI (`homie chat`) is an operator/debug tool.',
            'Set up at least one platform so your friend is reachable.',
          ].join('\n'),
        ),
      );

      wantsTelegram = guard(await p.confirm({ message: 'Set up Telegram?', initialValue: true }));
      if (wantsTelegram) {
        p.note(
          [
            '1) Open Telegram and message @BotFather',
            '2) Run /newbot and copy the HTTP API token',
            '3) Paste the token below (blank = skip)',
          ].join('\n'),
          'Telegram setup',
        );
        while (true) {
          const token = String(
            guard(
              await p.text({
                message: 'Telegram bot token',
                placeholder: '123456789:AA...',
              }),
            ),
          ).trim();
          if (!token) {
            wantsTelegram = false;
            break;
          }
          const tgSpin = p.spinner();
          tgSpin.start('Validating Telegram token...');
          const validation = await validateTelegramToken(token);
          if (!validation.ok) {
            tgSpin.stop('Token invalid');
            p.log.warn(`Telegram validation failed: ${validation.reason}`);
            const retry = guard(
              await p.confirm({ message: 'Try another token?', initialValue: true }),
            );
            if (!retry) {
              wantsTelegram = false;
              break;
            }
            continue;
          }
          tgSpin.stop(`Connected as @${validation.username}`);
          env.TELEGRAM_BOT_TOKEN = token;
          await upsertEnvValue(envPath, 'TELEGRAM_BOT_TOKEN', token);
          const operatorId = String(
            guard(
              await p.text({
                message: 'Your Telegram numeric user ID (message @userinfobot to find it)',
                initialValue: env.TELEGRAM_OPERATOR_USER_ID ?? '',
                placeholder: 'optional — enables test messages and operator privileges',
              }),
            ),
          ).trim();
          if (operatorId) {
            env.TELEGRAM_OPERATOR_USER_ID = operatorId;
            await upsertEnvValue(envPath, 'TELEGRAM_OPERATOR_USER_ID', operatorId);
            const runTestSend = guard(
              await p.confirm({
                message: 'Send a Telegram test message now?',
                initialValue: true,
              }),
            );
            if (runTestSend) {
              const tgTestSpin = p.spinner();
              tgTestSpin.start('Sending Telegram test message...');
              const sent = await sendTelegramTestMessage(token, operatorId);
              if (sent.ok) tgTestSpin.stop('Test message delivered');
              else {
                tgTestSpin.stop('Test message failed');
                p.log.warn(`Telegram test send failed: ${sent.reason}`);
                p.log.info(
                  'Tip: open a DM with your bot first, then use your numeric Telegram user ID.',
                );
              }
            }
          }
          break;
        }
      }

      wantsSignal = guard(
        await p.confirm({
          message: wantsTelegram ? 'Also set up Signal?' : 'Set up Signal?',
          initialValue: !wantsTelegram,
        }),
      );
      if (wantsSignal) {
        p.note(
          [
            `Run this daemon first (example): ${pc.cyan(SIGNAL_DOCKER_COMMAND)}`,
            'Provide the daemon URL and we will test connectivity.',
            'If your daemon supports link QR endpoints, we will show one in-terminal.',
          ].join('\n'),
          'Signal setup',
        );
        while (true) {
          const daemonUrl = normalizeHttpUrl(
            String(
              guard(
                await p.text({
                  message: 'Signal daemon URL',
                  initialValue: env.SIGNAL_DAEMON_URL ?? 'http://127.0.0.1:8080',
                }),
              ),
            ),
          );
          if (!daemonUrl) {
            wantsSignal = false;
            break;
          }
          const sigSpin = p.spinner();
          sigSpin.start('Checking Signal daemon health...');
          const health = await verifySignalDaemonHealth(daemonUrl);
          if (!health.ok) {
            sigSpin.stop('Daemon not reachable');
            p.log.warn(`Signal daemon check failed: ${health.reason}`);
            p.log.info(`Hint: ${signalDaemonHint(health.reason)}`);
            const retry = guard(
              await p.confirm({ message: 'Try another URL?', initialValue: true }),
            );
            if (!retry) {
              wantsSignal = false;
              break;
            }
            continue;
          }
          sigSpin.stop('Signal daemon reachable');
          env.SIGNAL_DAEMON_URL = daemonUrl;
          await upsertEnvValue(envPath, 'SIGNAL_DAEMON_URL', daemonUrl);

          const signalNumber = String(
            guard(
              await p.text({
                message: 'Signal account number (E.164, optional)',
                initialValue: env.SIGNAL_NUMBER ?? '',
              }),
            ),
          ).trim();
          if (signalNumber) {
            env.SIGNAL_NUMBER = signalNumber;
            await upsertEnvValue(envPath, 'SIGNAL_NUMBER', signalNumber);
          }
          const signalOperator = String(
            guard(
              await p.text({
                message: 'Signal operator number (optional)',
                initialValue: env.SIGNAL_OPERATOR_NUMBER ?? '',
              }),
            ),
          ).trim();
          if (signalOperator) {
            env.SIGNAL_OPERATOR_NUMBER = signalOperator;
            await upsertEnvValue(envPath, 'SIGNAL_OPERATOR_NUMBER', signalOperator);
          }

          const showLinkQr = guard(
            await p.confirm({
              message: 'Try generating a Signal pairing QR now?',
              initialValue: false,
            }),
          );
          if (showLinkQr) {
            const linkUri = await tryFetchSignalLinkUri(daemonUrl);
            if (linkUri) {
              p.log.message('Signal pairing QR:');
              try {
                qrcode.generate(linkUri, { small: true });
              } catch (_err) {
                // Terminal may not support QR rendering
              }
            } else {
              p.log.warn('Could not fetch pairing QR link from daemon.');
            }
          }
          break;
        }
      }
    } else {
      const defaults = await setDefaultModelsForProvider(provider);
      modelDefault = defaults.modelDefault;
      modelFast = defaults.modelFast;
      if (provider === 'mpp') {
        p.note(
          [
            'No API key required — requests paid from a wallet.',
            'Use a dedicated low-balance wallet for safety.',
            'You control the wallet; homie never holds your funds.',
            `Endpoint: ${pc.dim('https://mpp.tempo.xyz/openrouter/v1')}`,
          ].join('\n'),
          'MPP pay-per-use',
        );
      }
    }

    // ── Identity interview ────────────────────────────────────────
    if (shouldSkipInterview) {
      p.log.warn('Skipping interview is recommended until MPP wallet funding is verified.');
    }
    const runInterview = guard(
      await p.confirm({ message: 'Run identity interview?', initialValue: !shouldSkipInterview }),
    );

    if (runInterview) {
      const isAiUsable = isProviderUsable(provider, availability, env, ollamaDetected);

      const friendName = guard(await p.text({ message: 'Friend name', initialValue: 'Homie' }));
      const collectOperatorProfile = guard(
        await p.confirm({
          message:
            'Add operator relationship, bio, and technical context to improve identity quality?',
          initialValue: true,
        }),
      );
      if (collectOperatorProfile) {
        p.log.message(
          pc.dim(
            'Answer what you can. Type "skip" on any field to leave it blank and continue quickly.',
          ),
        );
        const operatorName = await askOptionalRichField({
          message: 'Operator name',
          placeholder: 'optional',
        });
        const relationshipDynamic = await askOptionalRichField({
          message: `How should ${friendName} relate to you (tone, boundaries, inside jokes)?`,
        });
        const biographyDetails = await askOptionalRichField({
          message: `Key biography details ${friendName} should know`,
          placeholder: 'history, place, family, life chapters',
        });
        const technicalDetails = await askOptionalRichField({
          message: `Technical context ${friendName} should understand`,
          placeholder: 'tools, domains, stack, workflows',
        });
        const consistencyReferences = await askOptionalRichField({
          message: 'Optional consistency references',
          placeholder: 'handles, sites, docs, or "skip"',
        });
        operatorProfile = {
          ...(operatorName ? { operatorName } : {}),
          ...(relationshipDynamic ? { relationshipDynamic } : {}),
          ...(biographyDetails ? { biographyDetails } : {}),
          ...(technicalDetails ? { technicalDetails } : {}),
          ...(consistencyReferences ? { consistencyReferences } : {}),
        };
        if (Object.keys(operatorProfile).length === 0) {
          operatorProfile = undefined;
        }
      }

      if (isAiUsable) {
        try {
          const tempConfig = makeTempConfig(provider, modelDefault, modelFast);
          const { backend } = await createBackend({ config: tempConfig, env });
          const client = new BackendAdapter(backend);

          const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
          const interviewUsage = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            costUsd: 0,
            txHash: undefined as string | undefined,
          };
          const onInterviewUsage = (usage: {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            reasoningTokens?: number | undefined;
            costUsd?: number | undefined;
            txHash?: string | undefined;
          }): void => {
            interviewUsage.inputTokens += usage.inputTokens ?? 0;
            interviewUsage.outputTokens += usage.outputTokens ?? 0;
            interviewUsage.reasoningTokens += usage.reasoningTokens ?? 0;
            interviewUsage.costUsd += usage.costUsd ?? 0;
            if (usage.txHash) interviewUsage.txHash = usage.txHash;
          };
          if (operatorProfile) {
            transcript.push({
              role: 'assistant',
              content: 'operator_profile',
            });
            transcript.push({
              role: 'user',
              content: buildOperatorContextBlock(operatorProfile, friendName),
            });
          }
          let questionsAsked = 0;
          const targetQuestions = 12;

          p.log.step(pc.bold(`Getting to know ${friendName}`));
          p.log.message(
            pc.dim(`We'll ask ~${targetQuestions} questions to build ${friendName}'s personality.`),
          );
          p.log.message(
            pc.dim('Type "skip" for any question or press Enter on empty input to wrap up.'),
          );

          while (true) {
            const sp = p.spinner();
            const spinnerLabel =
              questionsAsked === 0
                ? 'Preparing your first question...'
                : `Considering your answer... (${questionsAsked}/${targetQuestions})`;
            sp.start(spinnerLabel);
            const reasoning = createReasoningReporter('thinking');
            try {
              const next = await nextInterviewQuestion(client, {
                friendName,
                questionsAsked,
                transcript: transcript
                  .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
                  .join('\n'),
                operatorContext: buildOperatorContextBlock(operatorProfile, friendName),
                onReasoningDelta: reasoning.onReasoningDelta,
                onUsage: onInterviewUsage,
              });
              reasoning.stop();
              if (next.done) {
                sp.stop(pc.dim(`Interview complete — ${questionsAsked} questions answered`));
                break;
              }
              const q = next.question.trim();
              if (!q) throw new Error('Interview model produced empty question');

              sp.stop(pc.dim(`Question ${questionsAsked + 1} of ~${targetQuestions}`));

              const a = String(
                guard(
                  await p.text({
                    message: q,
                    placeholder: 'Type an answer, "skip", or press Enter to finish',
                  }),
                ),
              ).trim();
              if (!a) {
                p.log.info(`Wrapping up after ${questionsAsked} questions.`);
                break;
              }
              const answer = a.toLowerCase() === 'skip' ? '[skipped by operator]' : a;
              transcript.push({ role: 'assistant', content: q });
              transcript.push({ role: 'user', content: answer });
              questionsAsked++;
              if (questionsAsked >= 15) {
                p.log.info(`All ${questionsAsked} questions answered — generating identity.`);
                break;
              }
            } catch (err) {
              reasoning.stop();
              sp.stop('Could not reach model');
              const msg = err instanceof Error ? err.message : String(err);
              p.log.error(`Interview error: ${msg}`);
              const action = guard(
                await p.select({
                  message: 'What next?',
                  options: [
                    { value: 'retry', label: 'Retry this question' },
                    { value: 'cancel', label: 'Cancel setup' },
                  ],
                }),
              );
              if (action === 'cancel') cancelInit('Interview cancelled.');
            }
          }

          {
            const sp = p.spinner();
            sp.start(
              `Crafting ${friendName}'s identity from ${questionsAsked} answer${questionsAsked === 1 ? '' : 's'}...`,
            );
            const reasoning = createReasoningReporter('drafting identity');
            try {
              identityDraft = await generateIdentity(client, {
                friendName,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                transcript: transcript
                  .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
                  .join('\n'),
                operatorContext: buildOperatorContextBlock(operatorProfile, friendName),
                onReasoningDelta: reasoning.onReasoningDelta,
                onUsage: onInterviewUsage,
              });
              reasoning.stop();
              sp.stop(`${friendName}'s identity is ready`);
              providerVerifiedViaInterview = true;

              p.note(formatIdentityPreview(identityDraft, friendName), `${friendName}'s identity`);

              while (true) {
                const quality = scoreIdentityDraft({
                  draft: identityDraft,
                  ...(operatorProfile ? { operatorProfile } : {}),
                });
                p.note(
                  [
                    `overall: ${quality.overall}/100 (${quality.passes ? 'pass' : 'needs refinement'})`,
                    `specificity=${quality.breakdown.specificity} consistency=${quality.breakdown.consistency} depth=${quality.breakdown.depth}`,
                    `uniqueness=${quality.breakdown.uniqueness} operatorCoverage=${quality.breakdown.operatorCoverage}`,
                    ...(quality.issues.length > 0
                      ? [
                          '',
                          'focus areas:',
                          ...quality.issues.slice(0, 4).map((issue) => `- ${issue}`),
                        ]
                      : []),
                  ].join('\n'),
                  `${friendName} quality gate`,
                );
                const action = guard(
                  await p.select({
                    message: 'How does this look?',
                    options: [
                      { value: 'accept', label: 'Looks good — save it' },
                      { value: 'refine', label: 'Refine — give feedback and regenerate' },
                    ],
                  }),
                );
                if (action === 'accept') {
                  if (!quality.passes) {
                    const forceAccept = guard(
                      await p.confirm({
                        message:
                          'Quality checks suggest this draft is weak. Save anyway without refining?',
                        initialValue: false,
                      }),
                    );
                    if (!forceAccept) {
                      continue;
                    }
                  }
                  break;
                }

                const feedback = guard(
                  await p.text({ message: 'What would you change? Be specific.' }),
                );

                const refSp = p.spinner();
                refSp.start('Refining identity...');
                const refineReasoning = createReasoningReporter('refining');
                try {
                  identityDraft = await refineIdentity(client, {
                    feedback,
                    currentIdentity: identityDraft,
                    onReasoningDelta: refineReasoning.onReasoningDelta,
                    onUsage: onInterviewUsage,
                  });
                  refineReasoning.stop();
                  refSp.stop('Identity updated');

                  p.note(
                    formatIdentityPreview(identityDraft, friendName),
                    `${friendName}'s identity (refined)`,
                  );
                } catch (err) {
                  refineReasoning.stop();
                  refSp.stop('Refinement failed');
                  const msg = err instanceof Error ? err.message : String(err);
                  p.log.warn(`Keeping previous draft. (${msg})`);
                }
              }
              const totalTokens = interviewUsage.inputTokens + interviewUsage.outputTokens;
              if (totalTokens > 0 || interviewUsage.costUsd > 0) {
                p.note(
                  [
                    `llm usage: in=${interviewUsage.inputTokens} out=${interviewUsage.outputTokens} reasoning=${interviewUsage.reasoningTokens}`,
                    `estimated cost: $${interviewUsage.costUsd.toFixed(4)}`,
                    ...(interviewUsage.txHash ? [`latest tx: ${interviewUsage.txHash}`] : []),
                  ].join('\n'),
                  'Interview run metrics',
                );
              }
            } catch (genErr) {
              reasoning.stop();
              sp.stop('Generation failed');
              const msg = genErr instanceof Error ? genErr.message : String(genErr);
              p.log.error(`Could not generate identity: ${msg}`);
              failInit('Identity generation failed. Check your provider and try again.');
            }
          }
        } catch (backendErr) {
          const msg = backendErr instanceof Error ? backendErr.message : String(backendErr);
          p.log.error(`Failed to initialize AI backend: ${msg}`);
          failInit(
            'Cannot run interview without a working LLM. Fix the provider and rerun homie init.',
          );
        }
      } else {
        p.log.error('No working provider detected. homie needs an LLM to generate identity files.');
        p.log.message(
          [
            `${pc.dim('Options:')}`,
            `  ${pc.green('→')} Install Claude Code CLI (${pc.cyan('npm i -g @anthropic-ai/claude-code')})`,
            `  ${pc.green('→')} Set ${pc.cyan('ANTHROPIC_API_KEY')} or ${pc.cyan('OPENROUTER_API_KEY')} in .env`,
            `  ${pc.green('→')} Start Ollama locally (${pc.cyan('ollama serve')})`,
            `  ${pc.green('→')} Set ${pc.cyan('MPP_PRIVATE_KEY')} for pay-per-use`,
            '',
            'Then rerun homie init.',
          ].join('\n'),
        );
        failInit('No LLM provider available.');
      }

      const existingIdentity = [
        idPaths.soulPath,
        idPaths.stylePath,
        idPaths.userPath,
        idPaths.firstMeetingPath,
        idPaths.personalityPath,
      ];
      const hasExistingIdentity = (
        await Promise.all(existingIdentity.map(async (fp) => fileExists(fp)))
      ).some(Boolean);
      if (hasExistingIdentity) {
        overwriteIdentityFromInterview = guard(
          await p.confirm({
            message: 'Identity files already exist. Overwrite with interview output?',
            initialValue: false,
          }),
        );
      } else {
        overwriteIdentityFromInterview = true;
      }
    }
  }

  // ── Non-interactive guard ─────────────────────────────────────
  if (!interactive && configExists && !opts.force) {
    process.stderr.write(`homie init: ${configPath} already exists (use --force to overwrite)\n`);
    process.exit(1);
  }

  if (!interactive && shouldWriteConfig) {
    if (!recommendedProvider) {
      process.stderr.write(
        'homie init: no provider detected. Set an API key or install a CLI provider, then retry.\n',
      );
      process.exit(1);
    }
    provider = recommendedProvider;
    const defaults = await setDefaultModelsForProvider(provider);
    modelDefault = defaults.modelDefault;
    modelFast = defaults.modelFast;
  }

  if (provider === 'mpp') {
    const rpcUrl = normalizeHttpUrl(env.MPP_RPC_URL ?? '');
    if (!rpcUrl) {
      failInit('MPP provider requires MPP_RPC_URL in .env.');
    }
    if (rpcUrl.includes('base.org') || rpcUrl.includes('mainnet.base')) {
      failInit('MPP_RPC_URL must point to Tempo, not Base.');
    }
  }

  // ── Write phase (with spinner) ────────────────────────────────
  const writeSpin = p.spinner();
  if (interactive) writeSpin.start('Writing config and identity files...');

  await writeInitArtifacts({
    configPath,
    projectDir,
    identityDir,
    skillsDir,
    dataDir,
    envPath,
    idPaths,
    shouldWriteConfig,
    provider,
    modelDefault,
    modelFast,
    wantsTelegram,
    wantsSignal,
    identityDraft,
    overwriteIdentity: opts.force || overwriteIdentityFromInterview,
  });

  const configuredAgentKey = env[OPENHOMIE_AGENT_KEY_ENV]?.trim();
  if (configuredAgentKey && isValidAgentRuntimePrivateKey(configuredAgentKey)) {
    agentWalletAddress = privateKeyToAccount(configuredAgentKey as `0x${string}`).address;
  } else {
    const runtimeWallet = generateAgentRuntimeWallet();
    await upsertEnvValue(envPath, OPENHOMIE_AGENT_KEY_ENV, runtimeWallet.privateKey);
    env[OPENHOMIE_AGENT_KEY_ENV] = runtimeWallet.privateKey;
    agentWalletAddress = runtimeWallet.address;
    agentWalletGenerated = true;
  }
  if (interactive && agentWalletAddress) {
    const generatedLabel = agentWalletGenerated ? 'generated' : 'detected';
    p.log.success(
      `Agent runtime wallet ${generatedLabel}: ${pc.cyan(shortAddress(agentWalletAddress))}`,
    );
  }

  if (interactive && provider === 'mpp' && agentWalletAddress) {
    const shouldFundAgentWallet = guard(
      await p.confirm({
        message: `Fund your agent wallet on Tempo testnet now? (${shortAddress(agentWalletAddress)})`,
        initialValue: false,
      }),
    );
    if (shouldFundAgentWallet) {
      agentWalletFundAttempted = true;
      const fundSpin = p.spinner();
      fundSpin.start('Requesting Tempo faucet funding for your agent wallet...');
      try {
        await fundAgentTestnet({ address: agentWalletAddress as `0x${string}` });
        fundSpin.stop('Agent wallet funding requested');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fundSpin.stop('Agent wallet funding failed');
        p.log.warn(`Faucet request failed: ${message}`);
      }
    }
  }

  if (interactive) writeSpin.stop('Files written');

  // ── Completion ────────────────────────────────────────────────
  const hasAnyChannel = wantsTelegram || wantsSignal;
  const nextSteps: string[] = [];
  if (agentWalletAddress) {
    nextSteps.push('Keep OPENHOMIE_AGENT_KEY private; it is your agent identity wallet key');
  } else {
    nextSteps.push('Set OPENHOMIE_AGENT_KEY in .env (0x + 64 hex chars)');
  }
  if (shouldWriteConfig && !providerVerifiedViaInterview) {
    if (provider === 'anthropic') nextSteps.push('Set ANTHROPIC_API_KEY in .env');
    else if (provider === 'claude-code')
      nextSteps.push('Ensure `claude` CLI is logged in (run `claude` once to verify)');
    else if (provider === 'codex-cli') nextSteps.push('Run `codex login` to authenticate');
    else if (provider === 'openrouter') nextSteps.push('Set OPENROUTER_API_KEY in .env');
    else if (provider === 'openai') nextSteps.push('Set OPENAI_API_KEY in .env');
    else if (provider === 'mpp') {
      if (env.MPP_PRIVATE_KEY?.trim()) {
        nextSteps.push('Set MPP_RPC_URL to your Tempo RPC endpoint');
        nextSteps.push('Run `homie doctor --verify-mpp` after funding your wallet');
      } else {
        nextSteps.push('Set MPP_PRIVATE_KEY in .env (dedicated low-balance wallet)');
        nextSteps.push('Set MPP_RPC_URL in .env (Tempo RPC endpoint)');
      }
      if (!agentWalletFundAttempted && agentWalletAddress) {
        nextSteps.push(
          `Optional: fund agent wallet ${shortAddress(agentWalletAddress)} via tempo_fundAddress`,
        );
      }
      nextSteps.push('Optional: run `mppx account create`');
    } else if (provider === 'ollama') nextSteps.push('Start Ollama + pull your model');
  }
  nextSteps.push('Run `homie doctor`');
  if (provider === 'mpp') {
    nextSteps.push('Run `homie deploy` after wallet funding to provision a VPS');
  }
  if (hasAnyChannel) {
    nextSteps.push('Run `homie start` to launch your friend on Telegram/Signal');
  }
  nextSteps.push('Run `homie chat` for the CLI operator view');
  if (!hasAnyChannel) {
    nextSteps.push(
      pc.yellow('No chat platform configured — rerun `homie init` to add Telegram or Signal'),
    );
  }

  if (interactive) {
    const modeSummary = usedQuickStart ? 'quick start' : 'custom';
    p.note(
      [
        `${pc.dim('Mode')}      ${modeSummary}`,
        `${pc.dim('Provider')}  ${provider}`,
        `${pc.dim('Agent')}     ${agentWalletAddress ? shortAddress(agentWalletAddress) : 'not configured'}`,
        '',
        `${pc.dim('Created')}`,
        `  ${path.relative(process.cwd(), configPath) || 'homie.toml'}`,
        `  ${path.relative(process.cwd(), identityDir) || 'identity/'}`,
        `  ${path.relative(process.cwd(), path.join(projectDir, '.env.example')) || '.env.example'}`,
        '',
        `${pc.dim('Next steps')}`,
        ...nextSteps.map((s) => `  ${pc.green('→')} ${s}`),
      ].join('\n'),
      'homie init complete',
    );
    p.outro('Done. To redo identity later, rerun homie init and choose the interview again.');
  } else {
    process.stdout.write(
      [
        'homie init complete',
        '',
        `Mode: ${usedQuickStart ? 'quick start' : 'custom'}`,
        `Provider: ${provider}`,
        `Agent wallet: ${agentWalletAddress ?? 'not configured'}`,
        '',
        'Created/updated:',
        `- ${configPath}`,
        `- ${identityDir}`,
        `- ${projectDir}/.env.example`,
        '',
        'Next steps:',
        ...nextSteps.map((s) => `- ${s}`),
        '',
      ].join('\n'),
    );
  }
}
