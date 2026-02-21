import * as p from '@clack/prompts';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';

import {
  sendTelegramTestMessage,
  tryFetchSignalLinkUri,
  validateTelegramToken,
  verifySignalDaemonHealth,
} from '../../channels/validate.js';
import { upsertEnvValue } from '../../util/env.js';
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

export async function runTelegramSetup(env: InitEnv, envPath: string): Promise<boolean> {
  let wantsTelegram = true;

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
): Promise<boolean> {
  let wantsSignal = guard(
    await p.confirm({
      message: wantsTelegram ? 'Also set up Signal?' : 'Set up Signal?',
      initialValue: !wantsTelegram,
    }),
  );
  if (!wantsSignal) return false;

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
