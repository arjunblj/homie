import type { WalletAuditEvent } from './types.js';

const redactHash = (value: string): string => {
  if (!value.startsWith('0x') || value.length < 12) return '[redacted]';
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
};

export const redactWalletAuditEvent = (event: WalletAuditEvent): WalletAuditEvent => {
  return {
    ...event,
    ...(event.txHash ? { txHash: redactHash(event.txHash) } : {}),
    ...(event.metadata
      ? {
          metadata: Object.fromEntries(
            Object.entries(event.metadata).map(([key, value]) => {
              if (key.toLowerCase().includes('key') || key.toLowerCase().includes('secret')) {
                return [key, '[redacted]'];
              }
              return [key, value];
            }),
          ),
        }
      : {}),
  };
};

export const createWalletAuditEvent = (
  event: WalletAuditEvent['event'],
  partial: Omit<WalletAuditEvent, 'event' | 'atMs'>,
): WalletAuditEvent => {
  return {
    event,
    atMs: Date.now(),
    ...partial,
  };
};
