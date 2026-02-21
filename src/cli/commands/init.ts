import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { privateKeyToAccount } from 'viem/accounts';
import { loadOpenhomieConfig } from '../../config/load.js';
import { getIdentityPaths } from '../../identity/load.js';
import type { InitProvider } from '../../llm/detect.js';
import { detectProviderAvailability, recommendInitProvider } from '../../llm/detect.js';
import { upsertEnvValue } from '../../util/env.js';
import { shortAddress } from '../../util/format.js';
import { fileExists } from '../../util/fs.js';
import { normalizeHttpUrl } from '../../util/mpp.js';
import {
  fundAgentTestnet,
  generateAgentRuntimeWallet,
  isValidAgentRuntimePrivateKey,
  OPENHOMIE_AGENT_KEY_ENV,
} from '../../wallet/runtime.js';
import type { GlobalOpts } from '../args.js';
import { writeInitArtifacts } from './initArtifacts.js';
import { runSignalSetup, runTelegramSetup } from './initChannels.js';
import { printDetectionSummary } from './initFormat.js';
import { runIdentityInterview } from './initInterview.js';
import {
  listOllamaModelsBestEffort,
  probeOllamaBestEffort,
  resolveInterviewSelectionFromExistingConfig,
  runMppWalletFlow,
  setDefaultModelsForProvider,
} from './initProviders.js';
import { cancelInit, failInit, guard, type InitEnv } from './initTypes.js';

export {
  inferInitProviderFromConfig,
  resolveInterviewSelectionFromExistingConfig,
} from './initProviders.js';

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
  let identityDraft: import('../../interview/index.js').IdentityDraft | null = null;
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
          const mppResult = await runMppWalletFlow(env, envPath, availability);
          shouldSkipInterview = mppResult.shouldSkipInterview;
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
        wantsTelegram = await runTelegramSetup(env, envPath);
      }

      wantsSignal = await runSignalSetup(env, envPath, wantsTelegram);
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
    const interviewResult = await runIdentityInterview({
      shouldSkipInterview,
      provider,
      availability,
      env,
      ollamaDetected,
      modelDefault,
      modelFast,
      idPaths,
    });
    identityDraft = interviewResult.identityDraft;
    providerVerifiedViaInterview = interviewResult.providerVerifiedViaInterview;
    overwriteIdentityFromInterview = interviewResult.overwriteIdentityFromInterview;
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
