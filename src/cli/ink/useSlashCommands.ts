import { useCallback } from 'react';

import {
  COMMANDS,
  createMessage,
  formatCount,
  formatUsd,
  MPP_FUNDING_URL,
  parseAttachArgs,
  paymentStateLabel,
  shortAddress,
  TEMPO_CHAIN_LABEL,
  TEMPO_EXPLORER_BASE_URL,
} from './format.js';
import type { ChatMessage, ChatTurnInput, PaymentState, SessionMetrics } from './types.js';

export interface SlashCommandDeps {
  commitMessage: (message: ChatMessage) => void;
  queueOrRun: (turnInput: ChatTurnInput) => void;
  clearAll: () => void;
  exit: () => void;
  lastUserInput: ChatTurnInput | null;
  metrics: SessionMetrics;
  historyTrimmedCount: number;
  modelLabel: string;
  providerKind: string;
  agentWalletAddress: string | undefined;
  paymentWalletAddress: string | undefined;
  paymentState: PaymentState;
  paymentTxHash: string | undefined;
  paymentDetail: string | undefined;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCostUsd: number;
  sessionLlmCalls: number;
}

export function useSlashCommands(deps: SlashCommandDeps): (rawInput: string) => void {
  const {
    commitMessage,
    queueOrRun,
    clearAll,
    exit,
    lastUserInput,
    metrics,
    historyTrimmedCount,
    modelLabel,
    providerKind,
    agentWalletAddress,
    paymentWalletAddress,
    paymentState,
    paymentTxHash,
    paymentDetail,
    sessionInputTokens,
    sessionOutputTokens,
    sessionCostUsd,
    sessionLlmCalls,
  } = deps;

  return useCallback(
    (rawInput: string): void => {
      const [command] = rawInput.trim().split(/\s+/u);
      if (!command) return;

      if (command === '/exit' || command === '/quit') {
        exit();
        return;
      }
      if (command === '/clear') {
        clearAll();
        return;
      }
      if (command === '/help' || command === '/commands') {
        const lines = [
          'just type to chat',
          '',
          ...COMMANDS.map((c) => `  ${c.cmd.padEnd(12)} ${c.desc}`),
          '',
          '  ↑ / ↓        previous messages',
          '  tab          complete command',
          '  ctrl+c       stop (or exit if idle)',
          '  esc ×2       interrupt',
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      if (command === '/retry') {
        if (lastUserInput) {
          queueOrRun(lastUserInput);
        } else {
          commitMessage(createMessage('meta', 'nothing to retry yet', false));
        }
        return;
      }
      if (command === '/wallet') {
        const lines = [
          `network: ${TEMPO_CHAIN_LABEL}`,
          `agent: ${agentWalletAddress ? shortAddress(agentWalletAddress) : 'not configured'}`,
          ...(agentWalletAddress ? [`agent.full: ${agentWalletAddress}`] : []),
          ...(providerKind === 'mpp'
            ? [
                `payment mode: pay-per-use`,
                paymentWalletAddress
                  ? `payment: ${shortAddress(paymentWalletAddress)}`
                  : `payment: not configured`,
                ...(paymentWalletAddress
                  ? [`payment.account: ${TEMPO_EXPLORER_BASE_URL}/address/${paymentWalletAddress}`]
                  : ['set MPP_PRIVATE_KEY in .env and rerun homie doctor --verify-mpp']),
              ]
            : ['payment mode: disabled (provider is not mpp)']),
          `funding: ${MPP_FUNDING_URL}`,
          `explorer: ${TEMPO_EXPLORER_BASE_URL}`,
          ...(paymentDetail ? [`latest: ${paymentDetail}`] : []),
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      if (command === '/cost') {
        if (providerKind !== 'mpp') {
          commitMessage(
            createMessage('meta', 'cost tracking is only available in mpp mode', false),
          );
          return;
        }
        const totalTokens = sessionInputTokens + sessionOutputTokens;
        const lines = [
          `state: ${paymentStateLabel(paymentState)}`,
          `llm.calls: ${formatCount(sessionLlmCalls)}`,
          `in.tokens: ${formatCount(sessionInputTokens)}`,
          `out.tokens: ${formatCount(sessionOutputTokens)}`,
          `total.tokens: ${formatCount(totalTokens)}`,
          `session.cost: ${formatUsd(sessionCostUsd)}`,
          ...(paymentTxHash ? [`tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${paymentTxHash}`] : []),
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      if (command === '/attach') {
        const parsed = parseAttachArgs(rawInput);
        if ('error' in parsed) {
          commitMessage(createMessage('meta', parsed.error, false));
          return;
        }
        queueOrRun({
          text: parsed.text || 'sharing a file',
          attachments: [parsed.attachment],
        });
        return;
      }
      if (command === '/status') {
        const totalTokens = sessionInputTokens + sessionOutputTokens;
        const lines = [
          `model: ${modelLabel}`,
          ...(providerKind === 'mpp' && paymentWalletAddress
            ? [`payment.wallet: ${shortAddress(paymentWalletAddress)}`]
            : []),
          ...(agentWalletAddress ? [`agent.wallet: ${shortAddress(agentWalletAddress)}`] : []),
          ...(providerKind === 'mpp'
            ? [
                `network: ${TEMPO_CHAIN_LABEL}`,
                `wallet mode: pay-per-use`,
                `payment.state: ${paymentStateLabel(paymentState)}`,
                `session.llmCalls: ${formatCount(sessionLlmCalls)}`,
                `session.inTokens: ${formatCount(sessionInputTokens)}`,
                `explorer: ${TEMPO_EXPLORER_BASE_URL}`,
              ]
            : []),
          ...(providerKind === 'mpp'
            ? [`session.outTokens: ${formatCount(sessionOutputTokens)}`]
            : []),
          ...(providerKind === 'mpp' ? [`session.totalTokens: ${formatCount(totalTokens)}`] : []),
          ...(providerKind === 'mpp' && sessionCostUsd > 0
            ? [`session.cost: ${formatUsd(sessionCostUsd)}`]
            : []),
          ...(providerKind === 'mpp' && paymentTxHash
            ? [`payment.tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${paymentTxHash}`]
            : []),
          ...(providerKind === 'mpp' && paymentDetail ? [`payment.detail: ${paymentDetail}`] : []),
          `turns: ${metrics.turns}`,
          ...(metrics.queued > 0 ? [`waiting: ${metrics.queued}`] : []),
          ...(historyTrimmedCount > 0
            ? [`history.trimmed: ${formatCount(historyTrimmedCount)}`]
            : []),
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      commitMessage(createMessage('meta', `hmm, don't know ${command} — try /help`, false));
    },
    [
      commitMessage,
      exit,
      lastUserInput,
      metrics.queued,
      metrics.turns,
      modelLabel,
      providerKind,
      queueOrRun,
      agentWalletAddress,
      paymentDetail,
      paymentState,
      paymentTxHash,
      sessionLlmCalls,
      paymentWalletAddress,
      sessionCostUsd,
      sessionInputTokens,
      sessionOutputTokens,
      historyTrimmedCount,
      clearAll,
    ],
  );
}
