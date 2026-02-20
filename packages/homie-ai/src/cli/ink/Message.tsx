import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { renderMarkdown } from './markdown.js';
import { friendlyToolLabel, icons } from './theme.js';
import type { ChatMessage, ToolCallState, VerbosityMode } from './types.js';

export interface MessageProps {
  message: ChatMessage;
  toolCalls?: readonly ToolCallState[] | undefined;
  verbosity: VerbosityMode;
}

const termWidth = (): number => process.stdout.columns ?? 80;

const summarizeValue = (value: string): string =>
  value.length > 60 ? `${value.slice(0, 60).trim()}…` : value;

const summarizeReasoning = (value: string, maxLen = 100): string => {
  const flattened = value.replace(/\s+/gu, ' ').trim();
  if (!flattened) return '';
  return flattened.length > maxLen ? `${flattened.slice(0, maxLen).trimEnd()}…` : flattened;
};

// ── Typing indicator ──────────────────────────────────────────────

const TYPING_FRAMES = ['·  ', '·· ', '···', ' ··', '  ·', '   '];
const TYPING_INTERVAL_MS = 300;

export function TypingIndicator(): React.JSX.Element {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % TYPING_FRAMES.length);
    }, TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginLeft={2}>
      <Text color="gray">{TYPING_FRAMES[frame]}</Text>
    </Box>
  );
}

// ── Timestamp divider ─────────────────────────────────────────────

const TIMESTAMP_GAP_MS = 5 * 60 * 1000;

export function shouldShowTimestamp(
  current: ChatMessage,
  previous: ChatMessage | undefined,
): boolean {
  if (!previous) return false;
  return current.timestampMs - previous.timestampMs > TIMESTAMP_GAP_MS;
}

function formatTimestamp(ms: number): string {
  const now = new Date();
  const date = new Date(ms);
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function TimestampDivider({ timestampMs }: { timestampMs: number }): React.JSX.Element {
  return (
    <Box justifyContent="center" marginTop={1} marginBottom={1}>
      <Text color="gray" dimColor>
        {formatTimestamp(timestampMs)}
      </Text>
    </Box>
  );
}

// ── User message ──────────────────────────────────────────────────

function UserBubble({ message }: { message: ChatMessage }): React.JSX.Element {
  const w = Math.min(termWidth() - 8, 80);
  return (
    <Box
      marginLeft={6}
      width={w}
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      flexShrink={1}
    >
      <Text wrap="wrap">{message.content}</Text>
    </Box>
  );
}

// ── Friend message ────────────────────────────────────────────────

function FriendBubble({
  message,
  toolCalls,
  verbosity,
}: {
  message: ChatMessage;
  toolCalls?: readonly ToolCallState[] | undefined;
  verbosity: VerbosityMode;
}): React.JSX.Element {
  const content = message.content.trim();
  const reasoning = message.reasoningTrace?.trim() ?? '';
  const showThinking = message.isStreaming && content.length === 0;
  const w = Math.min(termWidth() - 4, 80);

  return (
    <Box flexDirection="column">
      {verbosity === 'verbose' && toolCalls && toolCalls.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          {toolCalls.map((tool) => {
            const icon =
              tool.status === 'running'
                ? icons.toolRunning
                : tool.status === 'done'
                  ? icons.toolDone
                  : icons.toolError;
            const color =
              tool.status === 'running' ? 'cyan' : tool.status === 'done' ? 'green' : 'red';
            return (
              <Text key={tool.id} color="gray" dimColor>
                <Text color={color}>{icon}</Text> {friendlyToolLabel(tool.name)}
                {tool.inputSummary ? ` ${icons.dot} ${summarizeValue(tool.inputSummary)}` : ''}
              </Text>
            );
          })}
        </Box>
      )}

      {showThinking && <TypingIndicator />}

      {verbosity === 'verbose' && reasoning && (
        <Box marginLeft={2} marginBottom={1} flexShrink={1}>
          <Text color="gray" dimColor>
            {'│ '}
          </Text>
          <Box flexShrink={1}>
            <Text color="gray" dimColor wrap="wrap">
              {summarizeReasoning(reasoning)}
            </Text>
          </Box>
        </Box>
      )}

      {content.length > 0 && (
        <Box
          marginLeft={1}
          width={w}
          borderStyle="double"
          borderColor="gray"
          borderDimColor
          paddingX={1}
          flexShrink={1}
        >
          <Text wrap="wrap">{message.isStreaming ? content : renderMarkdown(content)}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Meta message ──────────────────────────────────────────────────

function MetaMessage({ message }: { message: ChatMessage }): React.JSX.Element {
  if (message.kind === 'alert') {
    return (
      <Box marginLeft={2}>
        <Text color="yellow">{message.content}</Text>
      </Box>
    );
  }
  return (
    <Box marginLeft={2}>
      <Text color="gray" dimColor>
        {message.content}
      </Text>
    </Box>
  );
}

// ── Main export ───────────────────────────────────────────────────

const MessageComponent = ({ message, toolCalls, verbosity }: MessageProps): React.JSX.Element => {
  if (message.role === 'user') return <UserBubble message={message} />;
  if (message.role === 'meta') return <MetaMessage message={message} />;
  return <FriendBubble message={message} toolCalls={toolCalls} verbosity={verbosity} />;
};

export const Message = React.memo(MessageComponent);
