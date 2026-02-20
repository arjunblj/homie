export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const truncateText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

export const formatCount = (value: number): string => value.toLocaleString('en-US');

export const formatUsd = (value: number): string => {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (value < 0) return `-${formatUsd(-value)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
};

export const shortAddress = (address: string): string =>
  address.length <= 12 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;

export const shortTxHash = (hash: string): string =>
  hash.length <= 20 ? hash : `${hash.slice(0, 10)}...${hash.slice(-8)}`;
