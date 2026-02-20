import { execFile } from 'node:child_process';

import type { Address } from 'viem';

import type { AgentRuntimeWallet, OperatorRootAuthority } from './types.js';

interface GovernanceEnv extends NodeJS.ProcessEnv {
  HOMIE_OPERATOR_PASSKEY_ID?: string;
}

export interface GovernanceApprovalRequest {
  readonly action: 'grant' | 'rotate' | 'revoke' | 'raise_limits';
  readonly summary: string;
  readonly callbackUrl: string;
}

export interface GovernanceApprovalResult {
  readonly approved: boolean;
  readonly reason: 'approved' | 'cancelled' | 'timeout' | 'launch_failed';
}

const openUrl = async (url: string): Promise<boolean> => {
  const command =
    process.platform === 'darwin'
      ? { name: 'open', args: [url] }
      : process.platform === 'win32'
        ? { name: 'cmd', args: ['/c', 'start', '', url] }
        : { name: 'xdg-open', args: [url] };
  return await new Promise((resolve) => {
    execFile(command.name, command.args, (error) => resolve(!error));
  });
};

export const createOperatorRootAuthority = (
  env: GovernanceEnv,
): OperatorRootAuthority | undefined => {
  const credentialId = env.HOMIE_OPERATOR_PASSKEY_ID?.trim();
  if (!credentialId) return undefined;
  return {
    kind: 'passkey',
    label: 'Operator passkey',
    credentialId,
  };
};

export const runGovernanceApproval = async (
  request: GovernanceApprovalRequest,
  parameters?: {
    timeoutMs?: number | undefined;
    awaitCallback?: ((callbackUrl: string, timeoutMs: number) => Promise<boolean>) | undefined;
  },
): Promise<GovernanceApprovalResult> => {
  const opened = await openUrl(request.callbackUrl);
  if (!opened) return { approved: false, reason: 'launch_failed' };
  if (!parameters?.awaitCallback) {
    return { approved: false, reason: 'timeout' };
  }
  const timeoutMs = parameters.timeoutMs ?? 90_000;
  const approved = await parameters.awaitCallback(request.callbackUrl, timeoutMs);
  return approved
    ? { approved: true, reason: 'approved' }
    : { approved: false, reason: 'cancelled' };
};

export const createMacOsGuidance = (request: GovernanceApprovalRequest): string[] => {
  const base = [
    `Open browser approval for ${request.action}.`,
    'Use Touch ID when prompted to complete the passkey ceremony.',
    'If the prompt does not appear, retry from the same CLI command.',
    `Callback URL: ${request.callbackUrl}`,
  ];
  if (process.platform !== 'darwin') {
    base.unshift('Passkey ceremony uses browser flow on this platform.');
  }
  return base;
};

export const buildRotateRuntimeSummary = (
  oldWallet: AgentRuntimeWallet,
  nextWallet: AgentRuntimeWallet,
): string => {
  return `Rotate runtime wallet ${oldWallet.address} -> ${nextWallet.address}`;
};

export const buildGrantSummary = (parameters: {
  runtimeAddress: Address;
  operatorAddress?: Address | undefined;
}): string => {
  const operator = parameters.operatorAddress ?? 'operator-root';
  return `Grant scoped spend authority to ${parameters.runtimeAddress} via ${operator}`;
};
