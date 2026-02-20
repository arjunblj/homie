import { Box, Text } from 'ink';
import type React from 'react';
import { formatCount, formatUsd, paymentStateLabel, shortAddress, shortTxHash } from './format.js';
import { friendlyPhase, friendlyToolLabel, icons } from './theme.js';
import type {
  ChatPhase,
  PaymentState,
  SessionMetrics,
  UsageSummary,
  VerbosityMode,
} from './types.js';

interface StatusBarProps {
  modelLabel: string;
  metrics: SessionMetrics;
  phase: ChatPhase;
  verbosity: VerbosityMode;
  elapsedMs: number;
  hasPendingInterrupt: boolean;
  latestToolName?: string | undefined;
  showSilenceHint: boolean;
  activeAttachmentCount: number;
  providerKind: string;
  sessionUsage: UsageSummary;
  agentWalletAddress?: string | undefined;
  paymentWalletAddress?: string | undefined;
  paymentState: PaymentState;
  paymentTxHash?: string | undefined;
}

const formatElapsed = (ms: number): string => {
  const total = ms / 1000;
  if (total < 10) return `${total.toFixed(1)}s`;
  const s = Math.floor(total);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

export function StatusBar({
  modelLabel,
  phase,
  verbosity,
  elapsedMs,
  hasPendingInterrupt,
  latestToolName,
  metrics,
  showSilenceHint,
  activeAttachmentCount,
  providerKind,
  sessionUsage,
  agentWalletAddress,
  paymentWalletAddress,
  paymentState,
  paymentTxHash,
}: StatusBarProps): React.JSX.Element {
  const cols = process.stdout.columns ?? 80;
  const sepChar = icons.dot === '·' ? '─' : '-';
  const separator = sepChar.repeat(Math.min(cols, 100));
  const isActive = phase !== 'idle';
  const isMpp = providerKind === 'mpp';
  const totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens;
  const agentSummary = agentWalletAddress ? `agent ${shortAddress(agentWalletAddress)}` : '';

  const mppParts: string[] = [];
  if (isMpp) {
    if (paymentWalletAddress) mppParts.push(`pay ${shortAddress(paymentWalletAddress)}`);
    mppParts.push(paymentStateLabel(paymentState));
    if (sessionUsage.costUsd > 0) mppParts.push(`spent ${formatUsd(sessionUsage.costUsd)}`);
    else if (totalTokens > 0) mppParts.push(`${formatCount(totalTokens)} tokens`);
    if (paymentState === 'success' && paymentTxHash) {
      mppParts.push(`tx ${shortTxHash(paymentTxHash)}`);
    }
  }
  const mppSummary = mppParts.length > 0 ? ` ${icons.dot} ${mppParts.join(` ${icons.dot} `)}` : '';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray" dimColor>
        {separator}
      </Text>
      {isActive ? (
        <Box justifyContent="space-between">
          <Text color="gray" wrap="truncate">
            {' '}
            {icons.thinking} {friendlyPhase(phase, elapsedMs, latestToolName)} {icons.dot}{' '}
            {formatElapsed(elapsedMs)}
            {latestToolName
              ? ` ${icons.dot} ${icons.toolRunning} ${friendlyToolLabel(latestToolName)}`
              : ''}
            {activeAttachmentCount > 0
              ? ` ${icons.dot} ${icons.attachment} ${activeAttachmentCount} uploading`
              : ''}
            {metrics.queued > 0 ? ` ${icons.dot} ${metrics.queued} waiting` : ''}
            {agentSummary ? ` ${icons.dot} ${agentSummary}` : ''}
            {mppSummary}
          </Text>
          <Text color="gray" dimColor>
            {hasPendingInterrupt ? 'esc again to stop' : 'esc to interrupt'}
          </Text>
        </Box>
      ) : (
        <Box justifyContent="space-between">
          <Text color="gray" dimColor wrap="truncate">
            {' '}
            {modelLabel}
            {` ${icons.dot} ${metrics.turns} turns`}
            {verbosity === 'verbose' ? ` ${icons.dot} verbose` : ''}
            {agentSummary ? ` ${icons.dot} ${agentSummary}` : ''}
            {mppSummary}
          </Text>
          <Text color="gray" dimColor>
            {showSilenceHint ? 'chose not to reply' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
