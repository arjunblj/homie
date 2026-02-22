import { Box, Static, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useMemo } from 'react';
import { commandMatches, createMessage } from './format.js';
import { Message, shouldShowTimestamp, TimestampDivider, TypingIndicator } from './Message.js';
import { StatusBar } from './StatusBar.js';
import { formatBrand, icons, placeholderText } from './theme.js';
import type { ChatTurnStreamer } from './types.js';
import { useInputManager } from './useInputManager.js';
import { usePaymentTracker } from './usePaymentTracker.js';
import { useSessionUsage } from './useSessionUsage.js';
import { useSlashCommands } from './useSlashCommands.js';
import { useTurnProcessor } from './useTurnProcessor.js';

interface AppProps {
  modelLabel: string;
  startTurn: ChatTurnStreamer;
  providerKind: string;
  agentWalletAddress?: string | undefined;
  paymentWalletAddress?: string | undefined;
}

export function App({
  modelLabel,
  startTurn,
  providerKind,
  agentWalletAddress,
  paymentWalletAddress,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { input, setInput, inputHistory, historyOffsetRef, savedDraftRef, pushToHistory } =
    useInputManager();
  const payment = usePaymentTracker();
  const session = useSessionUsage();

  const tp = useTurnProcessor({
    startTurn,
    providerKind,
    paymentWalletAddress,
    payment,
    session,
  });

  const runSlashCommand = useSlashCommands({
    commitMessage: tp.commitMessage,
    queueOrRun: tp.queueOrRun,
    clearAll: tp.clearAll,
    exit,
    lastUserInput: tp.lastUserInput,
    metrics: tp.metrics,
    historyTrimmedCount: tp.historyTrimmedCount,
    modelLabel,
    providerKind,
    agentWalletAddress,
    paymentWalletAddress,
    paymentState: payment.state,
    paymentTxHash: payment.txHash,
    paymentDetail: payment.detail,
    sessionInputTokens: session.usage.inputTokens,
    sessionOutputTokens: session.usage.outputTokens,
    sessionCostUsd: session.usage.costUsd,
    sessionLlmCalls: session.llmCalls,
  });

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      if (tp.inFlightRef.current && tp.activeCancelRef.current) {
        tp.activeCancelRef.current();
        tp.commitMessage(createMessage('meta', 'stopped', false));
        return;
      }
      exit();
      return;
    }

    if (key.escape) {
      if (tp.inFlightRef.current && tp.activeCancelRef.current) {
        const now = Date.now();
        if (now - tp.lastEscAtMsRef.current < 1500) {
          tp.activeCancelRef.current();
          tp.setPendingEscInterrupt(false);
          tp.commitMessage(createMessage('meta', 'stopped', false));
        } else {
          tp.lastEscAtMsRef.current = now;
          tp.setPendingEscInterrupt(true);
        }
        return;
      }
      setInput('');
      historyOffsetRef.current = 0;
      return;
    }

    if (key.tab) {
      const matches = commandMatches(input);
      if (matches.length === 1 && matches[0]) setInput(matches[0].cmd);
      return;
    }

    if (key.upArrow) {
      if (inputHistory.length === 0) return;
      if (historyOffsetRef.current === 0) savedDraftRef.current = input;
      const next = Math.min(historyOffsetRef.current + 1, inputHistory.length);
      if (next !== historyOffsetRef.current) {
        historyOffsetRef.current = next;
        setInput(inputHistory[inputHistory.length - next] ?? '');
      }
      return;
    }

    if (key.downArrow) {
      if (historyOffsetRef.current <= 0) return;
      historyOffsetRef.current -= 1;
      if (historyOffsetRef.current === 0) {
        setInput(savedDraftRef.current);
      } else {
        setInput(inputHistory[inputHistory.length - historyOffsetRef.current] ?? '');
      }
      return;
    }

    if (key.return) {
      const normalized = input.trim();
      if (!normalized) return;
      pushToHistory(normalized);
      setInput('');
      if (normalized.startsWith('/')) runSlashCommand(normalized);
      else tp.queueOrRun({ text: normalized });
    } else if (key.backspace || key.delete) {
      historyOffsetRef.current = 0;
      setInput((prev) => {
        const chars = Array.from(prev);
        chars.pop();
        return chars.join('');
      });
    } else if (ch && !key.ctrl && !key.meta) {
      historyOffsetRef.current = 0;
      setInput((prev) => prev + ch);
    }
  });

  const visibleCommands = useMemo(() => commandMatches(input).slice(0, 4), [input]);
  const latestRunningToolName = useMemo(() => {
    for (let i = tp.toolCalls.length - 1; i >= 0; i -= 1) {
      const tool = tp.toolCalls[i];
      if (tool?.status === 'running') return tool.name;
    }
    return undefined;
  }, [tp.toolCalls]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>
          {'  '}
          {formatBrand()}
        </Text>
      </Box>

      {tp.committedMessages.length === 0 && !tp.activeMessage && (
        <Box justifyContent="center" marginBottom={1}>
          <Text color="gray" dimColor>
            /help for commands
          </Text>
        </Box>
      )}

      <Static items={tp.committedMessages}>
        {(msg, index) => {
          const prev = index > 0 ? tp.committedMessages[index - 1] : undefined;
          const senderChanged = prev !== undefined && prev.role !== msg.role;
          const showTs = shouldShowTimestamp(msg, prev);
          const gap = senderChanged || showTs || index === 0 ? 1 : 0;

          return (
            <Box key={msg.id} flexDirection="column" marginTop={gap}>
              {showTs && <TimestampDivider timestampMs={msg.timestampMs} />}
              <Message message={msg} />
            </Box>
          );
        }}
      </Static>

      {tp.activeMessage && tp.activeMessage.content.length > 0 && (
        <Box marginTop={1}>
          <Message
            message={{
              ...tp.activeMessage,
              reasoningTrace: tp.activeMessage.reasoningTrace ?? tp.activeReasoningTrace,
            }}
            toolCalls={tp.toolCalls}
          />
        </Box>
      )}

      {tp.showTypingDots && (!tp.activeMessage || tp.activeMessage.content.length === 0) && (
        <Box marginTop={1}>
          <TypingIndicator />
        </Box>
      )}

      <Box marginTop={1}>
        {input ? (
          <Text>
            {input}
            <Text color="gray">{icons.inputCursor}</Text>
          </Text>
        ) : (
          <Text color="gray" dimColor>
            {placeholderText}
          </Text>
        )}
      </Box>

      {visibleCommands.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          {visibleCommands.map((command) => (
            <Text key={command.cmd} color="gray">
              <Text color="cyan">{icons.command + command.cmd.slice(1)}</Text> {command.desc}
            </Text>
          ))}
        </Box>
      )}

      <StatusBar
        modelLabel={modelLabel}
        metrics={tp.metrics}
        phase={tp.phase}
        elapsedMs={tp.elapsedMs}
        hasPendingInterrupt={tp.pendingEscInterrupt}
        latestToolName={latestRunningToolName}
        showSilenceHint={tp.showSilenceHint}
        activeAttachmentCount={tp.activeAttachmentCount}
        providerKind={providerKind}
        sessionUsage={session.usage}
        agentWalletAddress={agentWalletAddress}
        paymentWalletAddress={paymentWalletAddress}
        paymentState={payment.state}
        paymentTxHash={payment.txHash}
        historyTrimmedCount={tp.historyTrimmedCount}
      />
    </Box>
  );
}
