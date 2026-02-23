import * as p from '@clack/prompts';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';

import {
  configureTelegramBotProfile,
  sendTelegramTestMessage,
  tryFetchSignalLinkUri,
  validateTelegramToken,
  verifySignalDaemonHealth,
} from '../../channels/validate.js';
import type { IdentityDraft } from '../../interview/schemas.js';
import { upsertEnvValue } from '../../util/env.js';
import { openUrl } from '../../util/fs.js';
import { normalizeHttpUrl } from '../../util/mpp.js';
import { guard, type InitEnv } from './initTypes.js';

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

const suggestBotUsername = (friendName: string): string => {
  const slug = friendName
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_|_$/gu, '');
  return `${slug || 'homie'}_bot`;
};

const extractBotDescription = (draft: IdentityDraft | null, friendName: string): string => {
  if (!draft?.soulMd) return `${friendName} — a friend on Telegram.`;
  const lines = draft.soulMd
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.slice(0, 3).join(' ').slice(0, 512) || `${friendName} — a friend on Telegram.`;
};

const extractShortDescription = (draft: IdentityDraft | null, friendName: string): string => {
  if (draft?.personality?.traits?.length) {
    const trait = draft.personality.traits[0] ?? '';
    const candidate = `${friendName} — ${trait}`;
    if (candidate.length <= 120) return candidate;
  }
  return friendName;
};

export interface TelegramSetupContext {
  friendName?: string | undefined;
  identityDraft?: IdentityDraft | null | undefined;
}

export async function runTelegramSetup(
  env: InitEnv,
  envPath: string,
  ctx?: TelegramSetupContext,
): Promise<boolean> {
  let wantsTelegram = true;
  const friendName = ctx?.friendName || 'Homie';
  const username = suggestBotUsername(friendName);

  const openBotFather = guard(
    await p.confirm({
      message: `Open @BotFather in Telegram to create ${friendName}'s bot?`,
      initialValue: true,
    }),
  );
  if (openBotFather) {
    await openUrl('https://t.me/BotFather?start');
  }

  p.note(
    [
      `In the BotFather chat:`,
      '',
      `  1) Send ${pc.cyan('/newbot')}`,
      `  2) When asked for a name, send: ${pc.bold(friendName)}`,
      `  3) When asked for a username, try: ${pc.bold(username)}`,
      `     ${pc.dim('(must end in "bot" and be unique — add numbers if taken)')}`,
      `  4) Copy the ${pc.bold('HTTP API token')} and paste it below`,
    ].join('\n'),
    `Create ${friendName}'s Telegram bot`,
  );

  while (true) {
    const token = String(
      guard(
        await p.text({
          message: 'Paste the bot token from BotFather',
          placeholder: '123456789:AA...',
        }),
      ),
    ).trim();
    if (!token) {
      wantsTelegram = false;
      break;
    }
    const tgSpin = p.spinner();
    tgSpin.start('Validating token...');
    const validation = await validateTelegramToken(token);
    if (!validation.ok) {
      tgSpin.stop('Token invalid');
      p.log.warn(`Telegram validation failed: ${validation.reason}`);
      const retry = guard(await p.confirm({ message: 'Try another token?', initialValue: true }));
      if (!retry) {
        wantsTelegram = false;
        break;
      }
      continue;
    }
    tgSpin.stop(`Connected as @${validation.username}`);
    env.TELEGRAM_BOT_TOKEN = token;
    await upsertEnvValue(envPath, 'TELEGRAM_BOT_TOKEN', token);

    const profileSpin = p.spinner();
    profileSpin.start(`Configuring ${friendName}'s bot profile...`);
    const profileResult = await configureTelegramBotProfile({
      token,
      name: friendName,
      description: extractBotDescription(ctx?.identityDraft ?? null, friendName),
      shortDescription: extractShortDescription(ctx?.identityDraft ?? null, friendName),
    });
    if (profileResult.ok && profileResult.applied.length > 0) {
      profileSpin.stop(`Bot profile set (${profileResult.applied.join(', ')})`);
    } else {
      profileSpin.stop('Bot connected (profile config skipped)');
    }

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
          p.log.info('Tip: open a DM with your bot first, then use your numeric Telegram user ID.');
        }
      }
    }
    break;
  }

  return wantsTelegram;
}

export async function runSignalSetup(
  env: InitEnv,
  envPath: string,
  wantsTelegram: boolean,
  skipConfirm?: boolean,
): Promise<boolean> {
  if (!skipConfirm) {
    const confirmed = guard(
      await p.confirm({
        message: wantsTelegram ? 'Also set up Signal?' : 'Set up Signal?',
        initialValue: !wantsTelegram,
      }),
    );
    if (!confirmed) return false;
  }
  let wantsSignal = true;

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
      const retry = guard(await p.confirm({ message: 'Try another URL?', initialValue: true }));
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

  return wantsSignal;
}
