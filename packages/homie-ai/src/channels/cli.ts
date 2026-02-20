import readline from 'node:readline';

import { render } from 'ink';
import React from 'react';
import { privateKeyToAccount } from 'viem/accounts';

import { App } from '../cli/ink/App.js';
import { ErrorBoundary } from '../cli/ink/ErrorBoundary.js';
import {
  classifyPaymentState,
  EMPTY_USAGE,
  formatCount,
  formatUsd,
  MPP_FUNDING_URL,
  paymentStateLabel,
  shortAddress,
  shortTxHash,
  TEMPO_CHAIN_LABEL,
  TEMPO_EXPLORER_BASE_URL,
} from '../cli/ink/format.js';
import { detectTerminalCapabilities } from '../cli/ink/terminalCapabilities.js';
import type { PaymentState, UsageSummary } from '../cli/ink/types.js';
import type { HomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { AgentRuntimeWallet, WalletConnectionLifecycle } from '../wallet/types.js';
import { createCliTurnHandler } from './cli-turn.js';

export interface RunCliChatOptions {
  config: HomieConfig;
  engine: TurnEngine;
  agentWallet?: AgentRuntimeWallet | undefined;
}

export const toCliErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const derivePaymentWalletAddress = (
  env: NodeJS.ProcessEnv & { MPP_PRIVATE_KEY?: string | undefined },
): string | undefined => {
  const key = env.MPP_PRIVATE_KEY?.trim();
  if (!key) return undefined;
  try {
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    return undefined;
  }
};

export const runCliChat = async ({
  config,
  engine,
  agentWallet,
}: RunCliChatOptions): Promise<void> => {
  const modelLabel = config.model.models.default;
  const capabilities = detectTerminalCapabilities(process.env);
  const paymentWalletAddress =
    config.model.provider.kind === 'mpp' ? derivePaymentWalletAddress(process.env) : undefined;
  const agentWalletAddress = agentWallet?.address;
  const startTurn = createCliTurnHandler(engine, {
    deltaBatchMs: capabilities.recommendedDeltaBatchMs,
  });
  const env = process.env as NodeJS.ProcessEnv & { TERM?: string };
  if (!process.stdin.isTTY || !process.stdout.isTTY || env.TERM === 'dumb') {
    await runPlainChat({
      startTurn,
      providerKind: config.model.provider.kind,
      agentWalletAddress,
      paymentWalletAddress,
    });
    return;
  }

  const { waitUntilExit } = render(
    React.createElement(
      ErrorBoundary,
      null,
      React.createElement(App, {
        modelLabel,
        startTurn,
        providerKind: config.model.provider.kind,
        agentWalletAddress,
        paymentWalletAddress,
      }),
    ),
    {
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitUntilExit();
};

const runPlainChat = async (opts: {
  startTurn: ReturnType<typeof createCliTurnHandler>;
  providerKind: HomieConfig['model']['provider']['kind'];
  agentWalletAddress?: string | undefined;
  paymentWalletAddress?: string | undefined;
}): Promise<void> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  let activeTurn: ReturnType<typeof opts.startTurn> | null = null;
  let sessionUsage: UsageSummary = { ...EMPTY_USAGE };
  let sessionLlmCalls = 0;
  let latestPaymentState: PaymentState = opts.providerKind === 'mpp' ? 'ready' : 'unknown';
  let paymentConnectionState: WalletConnectionLifecycle =
    opts.providerKind === 'mpp'
      ? opts.paymentWalletAddress
        ? 'connected'
        : 'disconnected'
      : 'disconnected';
  let latestPaymentTxHash: string | undefined;
  const printMeta = (message: string): void => {
    process.stdout.write(`[meta] ${message}\n`);
  };
  const printBlock = (lines: readonly string[]): void => {
    process.stdout.write(`${lines.join('\n')}\n`);
  };

  const onSigint = (): void => {
    if (activeTurn) {
      activeTurn.cancel();
      printMeta('stopped');
      return;
    }
    rl.close();
  };

  process.on('SIGINT', onSigint);
  process.stdout.write(
    'homie (plain mode) — /exit to quit, /wallet shows agent + payment status\n',
  );
  if (opts.providerKind === 'mpp') {
    printBlock([
      '[mpp] preflight',
      `[mpp] network: ${TEMPO_CHAIN_LABEL}`,
      `[mpp] payment wallet: ${opts.paymentWalletAddress ? shortAddress(opts.paymentWalletAddress) : 'not configured'}`,
      ...(opts.paymentWalletAddress
        ? [`[mpp] account: ${TEMPO_EXPLORER_BASE_URL}/address/${opts.paymentWalletAddress}`]
        : []),
      `[mpp] funding: ${MPP_FUNDING_URL}`,
      `[mpp] explorer: ${TEMPO_EXPLORER_BASE_URL}`,
    ]);
  }
  rl.setPrompt('> ');
  rl.prompt();

  rl.on('line', async (line) => {
    try {
      if (activeTurn) {
        printMeta('turn in progress (press Ctrl+C to stop)');
        if (!closed) rl.prompt();
        return;
      }

      const text = line.trim();
      if (!text) {
        if (!closed) rl.prompt();
        return;
      }
      if (text === '/exit' || text === '/quit') {
        rl.close();
        return;
      }
      if (text === '/wallet') {
        printBlock([
          `[wallet] network: ${TEMPO_CHAIN_LABEL}`,
          `[wallet] agent: ${opts.agentWalletAddress ? shortAddress(opts.agentWalletAddress) : 'not configured'}${opts.agentWalletAddress ? ` (${opts.agentWalletAddress})` : ''}`,
          ...(opts.providerKind === 'mpp'
            ? [
                `[wallet] payment: ${opts.paymentWalletAddress ? shortAddress(opts.paymentWalletAddress) : 'not configured'}`,
                `[wallet] payment connection: ${paymentConnectionState}`,
                `[wallet] payment state: ${paymentStateLabel(latestPaymentState)}`,
                ...(opts.paymentWalletAddress
                  ? [
                      `[wallet] payment account: ${TEMPO_EXPLORER_BASE_URL}/address/${opts.paymentWalletAddress}`,
                    ]
                  : ['[wallet] set MPP_PRIVATE_KEY and rerun homie doctor --verify-mpp']),
              ]
            : ['[wallet] payment mode: disabled (provider is not mpp)']),
          `[wallet] funding: ${MPP_FUNDING_URL}`,
          `[wallet] explorer: ${TEMPO_EXPLORER_BASE_URL}`,
          ...(latestPaymentTxHash ? [`[wallet] last tx: ${shortTxHash(latestPaymentTxHash)}`] : []),
        ]);
        if (!closed) rl.prompt();
        return;
      }
      if (text === '/cost') {
        if (opts.providerKind !== 'mpp') {
          printMeta('cost tracking is only available in mpp mode');
        } else {
          const totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens;
          printBlock([
            `[cost] state: ${paymentStateLabel(latestPaymentState)}`,
            `[cost] llm calls: ${formatCount(sessionLlmCalls)}`,
            `[cost] in tokens: ${formatCount(sessionUsage.inputTokens)}`,
            `[cost] out tokens: ${formatCount(sessionUsage.outputTokens)}`,
            `[cost] total tokens: ${formatCount(totalTokens)}`,
            `[cost] session: ${formatUsd(sessionUsage.costUsd)}`,
            ...(latestPaymentTxHash
              ? [`[cost] tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${latestPaymentTxHash}`]
              : []),
          ]);
        }
        if (!closed) rl.prompt();
        return;
      }

      if (opts.providerKind === 'mpp') {
        latestPaymentState = 'pending';
        paymentConnectionState = 'connecting';
        latestPaymentTxHash = undefined;
      }

      const turn = opts.startTurn({ text });
      activeTurn = turn;
      let hasStreamedText = false;
      let wrotePrefix = false;
      try {
        for await (const event of turn.events) {
          if (event.type === 'text_delta' && event.text) {
            if (!wrotePrefix) {
              process.stdout.write('homie: ');
              wrotePrefix = true;
            }
            hasStreamedText = true;
            process.stdout.write(event.text);
            continue;
          }

          if (event.type === 'meta') {
            if (wrotePrefix) {
              process.stdout.write('\n');
              wrotePrefix = false;
            }
            if (opts.providerKind === 'mpp' && event.message.toLowerCase().startsWith('error:')) {
              latestPaymentState = classifyPaymentState(event.message);
              const low = event.message.toLowerCase();
              paymentConnectionState =
                low.includes('timeout') ||
                low.includes('unreachable') ||
                low.includes('econn') ||
                low.includes('fetch failed')
                  ? 'reconnecting'
                  : low.includes('invalid') && low.includes('key')
                    ? 'disconnected'
                    : 'connected';
            }
            printMeta(event.message);
            continue;
          }

          if (event.type === 'usage') {
            if (wrotePrefix) {
              process.stdout.write('\n');
              wrotePrefix = false;
            }
            sessionUsage = {
              inputTokens: sessionUsage.inputTokens + event.summary.usage.inputTokens,
              outputTokens: sessionUsage.outputTokens + event.summary.usage.outputTokens,
              cacheReadTokens: sessionUsage.cacheReadTokens + event.summary.usage.cacheReadTokens,
              cacheWriteTokens:
                sessionUsage.cacheWriteTokens + event.summary.usage.cacheWriteTokens,
              reasoningTokens: sessionUsage.reasoningTokens + event.summary.usage.reasoningTokens,
              costUsd: sessionUsage.costUsd + event.summary.usage.costUsd,
            };
            sessionLlmCalls += event.summary.llmCalls;
            if (opts.providerKind === 'mpp') {
              paymentConnectionState = 'connected';
              latestPaymentState = 'success';
              if (event.summary.txHash) latestPaymentTxHash = event.summary.txHash;
            }
            const totalTokens = event.summary.usage.inputTokens + event.summary.usage.outputTokens;
            printBlock([
              `[receipt] state: ${paymentStateLabel(latestPaymentState)}`,
              `[receipt] in ${formatCount(event.summary.usage.inputTokens)} | out ${formatCount(event.summary.usage.outputTokens)} | total ${formatCount(totalTokens)}`,
              `[receipt] cost: ${formatUsd(event.summary.usage.costUsd)}`,
              ...(event.summary.txHash
                ? [`[receipt] tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${event.summary.txHash}`]
                : []),
            ]);
            continue;
          }

          if (event.type !== 'done') continue;
          if (wrotePrefix) {
            process.stdout.write('\n');
            wrotePrefix = false;
          }

          if (event.result.kind === 'send_text') {
            if (opts.providerKind === 'mpp' && latestPaymentState === 'pending') {
              paymentConnectionState = opts.paymentWalletAddress ? 'connected' : 'disconnected';
              latestPaymentState = 'success';
            }
            const fallbackText = event.result.text.trim();
            if (!hasStreamedText && fallbackText) process.stdout.write(`homie: ${fallbackText}\n`);
            continue;
          }

          if (event.result.kind === 'react') {
            if (opts.providerKind === 'mpp' && latestPaymentState === 'pending') {
              paymentConnectionState = opts.paymentWalletAddress ? 'connected' : 'disconnected';
              latestPaymentState = 'success';
            }
            process.stdout.write(`homie reacted: ${event.result.emoji}\n`);
            continue;
          }

          if (event.result.kind === 'silence') {
            if (opts.providerKind === 'mpp') {
              latestPaymentState =
                event.result.reason === 'interrupted'
                  ? 'cancelled'
                  : event.result.reason === 'turn_error'
                    ? 'failed'
                    : latestPaymentState === 'pending'
                      ? 'ready'
                      : latestPaymentState;
              if (event.result.reason === 'turn_error') {
                paymentConnectionState = 'reconnecting';
              }
            }
            printMeta(`silence: ${event.result.reason ?? 'no_reply'}`);
          }
        }
      } finally {
        if (wrotePrefix) process.stdout.write('\n');
        activeTurn = null;
        if (!closed) rl.prompt();
      }
    } catch (err) {
      const msg = toCliErrorMessage(err);
      if (opts.providerKind === 'mpp') {
        latestPaymentState = classifyPaymentState(msg);
      }
      printMeta(`error: ${msg}`);
      activeTurn = null;
      if (!closed) rl.prompt();
    }
  });

  await new Promise<void>((resolve) =>
    rl.once('close', () => {
      closed = true;
      activeTurn?.cancel();
      process.off('SIGINT', onSigint);
      resolve();
    }),
  );
};
