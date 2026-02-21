import { Box, Text } from 'ink';
import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(_error: unknown): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: unknown): void {
    const kind = error instanceof Error ? error.name : 'UnknownError';
    process.stderr.write(`[homie] ink_ui_error kind=${kind}\n`);
  }

  public override render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color="red">something went wrong</Text>
        <Text color="gray">
          run <Text color="cyan">homie chat</Text> to start a new session
        </Text>
      </Box>
    );
  }
}
