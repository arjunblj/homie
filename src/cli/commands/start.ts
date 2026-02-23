import path from 'node:path';

import * as p from '@clack/prompts';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import type { LoadedOpenhomieConfig } from '../../config/load.js';
import { loadOpenhomieConfig } from '../../config/load.js';
import { detectProviderAvailability } from '../../llm/detect.js';
import { deriveMppWalletAddress } from '../../util/mpp.js';
import type { GlobalOpts } from '../args.js';
import { runInitCommand } from './init.js';
import { runSignalSetup, runTelegramSetup } from './initChannels.js';
import { runMppWalletFlow } from './initProviders.js';
import { guard, type InitEnv } from './initTypes.js';
import { MppVerifyError, verifyMppModelAccess } from './mppVerify.js';

const isInteractiveStart = (opts: GlobalOpts): boolean => {
  if (!opts.interactive || opts.yes || opts.json) return false;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
};

const hasAnyChannelConfigured = (env: NodeJS.ProcessEnv): boolean => {
  const e = env as NodeJS.ProcessEnv & {
    TELEGRAM_BOT_TOKEN?: string | undefined;
    SIGNAL_DAEMON_URL?: string | undefined;
    SIGNAL_HTTP_URL?: string | undefined;
    SIGNAL_API_URL?: string | undefined;
  };
  return Boolean(
    e.TELEGRAM_BOT_TOKEN?.trim() ||
      e.SIGNAL_DAEMON_URL?.trim() ||
      e.SIGNAL_HTTP_URL?.trim() ||
      e.SIGNAL_API_URL?.trim(),
  );
};

const ensureConfigExistsOrInit = async (opts: GlobalOpts): Promise<LoadedOpenhomieConfig> => {
  try {
    return await loadOpenhomieConfig({
      cwd: process.cwd(),
      env: process.env,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const interactive = isInteractiveStart(opts);
    const looksLikeMissingConfig = msg.toLowerCase().includes('could not find homie.toml');
    if (!interactive || !looksLikeMissingConfig) throw err;

    p.intro(pc.bold('homie start'));
    p.note(
      [
        'No homie.toml found in this directory (or parents).',
        "We'll create config + identity templates now.",
      ].join('\n'),
      'First-time setup',
    );

    const mode = guard(
      await p.select({
        message: 'How do you want to set up?',
        options: [
          {
            value: 'quick',
            label: 'Quick start',
            hint: 'recommended — get running fast, customize later',
          },
          {
            value: 'full',
            label: 'Full setup with identity interview',
            hint: "define your friend's personality now",
          },
          { value: 'cancel', label: 'Cancel' },
        ],
        initialValue: 'quick',
      }),
    );
    if (mode === 'cancel') {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    await runInitCommand(opts, { defaultRunInterview: mode === 'full', isFromStart: true });

    // Reload config after init writes it.
    return await loadOpenhomieConfig({
      cwd: process.cwd(),
      env: process.env,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
  }
};

const ensureChannelsConfigured = async (opts: GlobalOpts, loaded: LoadedOpenhomieConfig) => {
  if (hasAnyChannelConfigured(process.env)) return;
  if (!isInteractiveStart(opts)) {
    throw new Error('no channels configured. Set TELEGRAM_BOT_TOKEN or SIGNAL_DAEMON_URL in .env.');
  }

  const env = process.env as InitEnv;
  const envPath = path.join(loaded.config.paths.projectDir, '.env');

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

  let wantsTelegram = guard(await p.confirm({ message: 'Set up Telegram?', initialValue: true }));
  if (wantsTelegram) wantsTelegram = await runTelegramSetup(env, envPath);
  const wantsSignal = await runSignalSetup(env, envPath, wantsTelegram);

  if (!wantsTelegram && !wantsSignal) {
    if (isInteractiveStart(opts)) {
      p.cancel('No channels configured. Your friend needs a way to hear you.');
      process.exit(1);
    }
    throw new Error('no channels configured. Run `homie init` to set up Telegram or Signal.');
  }
};

const ensureMppWalletFundedIfNeeded = async (opts: GlobalOpts, loaded: LoadedOpenhomieConfig) => {
  if (loaded.config.model.provider.kind !== 'mpp') return;

  const env = process.env as InitEnv;
  const envPath = path.join(loaded.config.paths.projectDir, '.env');

  // If the user selected MPP but has missing keys, reuse the init wallet flow.
  const availability = await detectProviderAvailability(env);
  if (!env.MPP_PRIVATE_KEY?.trim() || !env.MPP_RPC_URL?.trim()) {
    await runMppWalletFlow(env, envPath, availability);
  }

  const address = deriveMppWalletAddress(env.MPP_PRIVATE_KEY) ?? 'unknown';
  if (isInteractiveStart(opts) && address !== 'unknown') {
    p.log.step(pc.bold('Verify wallet funding'));
    p.log.message(pc.dim(`Wallet: ${address}`));
    try {
      qrcode.generate(`ethereum:${address}`, { small: true });
    } catch (_err) {
      // Terminal may not support QR rendering.
    }
    const rpcUrl = (env.MPP_RPC_URL ?? '').trim();
    if (rpcUrl.includes('rpc.moderato.tempo.xyz')) {
      p.log.message(
        pc.dim(
          `Testnet faucet: cast rpc tempo_fundAddress ${address} --rpc-url https://rpc.moderato.tempo.xyz`,
        ),
      );
    }
  }

  // Best-in-class behavior: if you're using MPP, make sure you're funded before we start.
  const modelFast = loaded.config.model.models.fast;
  const baseUrl =
    loaded.config.model.provider.kind === 'mpp' ? loaded.config.model.provider.baseUrl : undefined;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const sp = isInteractiveStart(opts) ? p.spinner() : null;
      sp?.start(`Checking MPP wallet readiness (attempt ${String(attempt)})...`);
      await verifyMppModelAccess({
        env,
        model: modelFast,
        baseUrl,
        timeoutMs: 12_000,
      });
      sp?.stop('MPP wallet verified');
      return;
    } catch (err) {
      const failure =
        err instanceof MppVerifyError
          ? err.failure
          : {
              code: 'unknown',
              detail: err instanceof Error ? err.message : String(err),
              nextStep: '',
            };

      if (!isInteractiveStart(opts)) {
        throw new Error(
          `MPP wallet not ready (${failure.code}). ${failure.nextStep || 'Run homie doctor --verify-mpp for details.'}`,
        );
      }

      p.log.warn(`MPP wallet not ready [${failure.code}] ${failure.detail}`);
      if (failure.nextStep) p.log.info(failure.nextStep);

      const action = guard(
        await p.select({
          message: 'What would you like to do?',
          options: [
            { value: 'check', label: 'Check again', hint: 'after funding the wallet' },
            {
              value: 'skip',
              label: 'Skip for now',
              hint: 'you can verify later with homie doctor --verify-mpp',
            },
            { value: 'abort', label: 'Cancel' },
          ],
          initialValue: 'check',
        }),
      );
      if (action === 'skip') {
        p.log.message(
          pc.dim(
            'Continuing without MPP verification. Run `homie doctor --verify-mpp` to check later.',
          ),
        );
        return;
      }
      if (action === 'abort') {
        p.cancel('Start cancelled.');
        process.exit(0);
      }
    }
  }
};

export const runStartCommand = async (
  opts: GlobalOpts,
  cmdArgs: readonly string[],
): Promise<void> => {
  const loaded = await ensureConfigExistsOrInit(opts);
  await ensureChannelsConfigured(opts, loaded);
  await ensureMppWalletFundedIfNeeded(opts, loaded);

  if (isInteractiveStart(opts)) {
    p.log.step(pc.bold('Launching your friend'));
    p.log.message(pc.dim('Press Ctrl+C to stop'));
  }
  const { runMain } = await import('../../harness/harness.js');
  await runMain('start', [...cmdArgs]);
};
