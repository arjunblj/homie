import type { Address } from 'viem';

import { openUrl } from '../util/fs.js';
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

const isAllowedCallbackScheme = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch (_err) {
    return false;
  }
};

export const runGovernanceApproval = async (
  request: GovernanceApprovalRequest,
  parameters?: {
    timeoutMs?: number | undefined;
    awaitCallback?: ((callbackUrl: string, timeoutMs: number) => Promise<boolean>) | undefined;
    openUrl?: ((url: string) => Promise<boolean>) | undefined;
  },
): Promise<GovernanceApprovalResult> => {
  if (!isAllowedCallbackScheme(request.callbackUrl)) {
    return { approved: false, reason: 'launch_failed' };
  }
  const open = parameters?.openUrl ?? openUrl;
  const opened = await open(request.callbackUrl);
  if (!opened) return { approved: false, reason: 'launch_failed' };
  if (!parameters?.awaitCallback) {
    return { approved: false, reason: 'timeout' };
  }
  const timeoutMs = parameters.timeoutMs ?? 90_000;
  try {
    const approved = await parameters.awaitCallback(request.callbackUrl, timeoutMs);
    return approved
      ? { approved: true, reason: 'approved' }
      : { approved: false, reason: 'cancelled' };
  } catch (_err) {
    return { approved: false, reason: 'launch_failed' };
  }
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
