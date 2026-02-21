import { readFile, writeFile } from 'node:fs/promises';

const escapeForRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const SIMPLE_ENV_VALUE_PATTERN = /^[A-Za-z0-9_./:@-]+$/u;

const formatEnvValue = (value: string): string => {
  const normalized = value.replaceAll('\r\n', '\n');
  if (normalized.includes('\n') || normalized.includes('\r')) {
    const escaped = normalized
      .replaceAll('\\', '\\\\')
      .replaceAll('\r', '\\r')
      .replaceAll('\n', '\\n')
      .replaceAll('"', '\\"');
    return `"${escaped}"`;
  }
  if (normalized === '') return '""';
  if (SIMPLE_ENV_VALUE_PATTERN.test(normalized)) return normalized;
  const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
};

export const upsertEnvValue = async (
  envPath: string,
  key: string,
  value: string,
): Promise<void> => {
  const keyPattern = new RegExp(`^\\s*${escapeForRegex(key)}\\s*=`);
  const existing = (await readFile(envPath, 'utf8').catch(() => '')).replaceAll('\r\n', '\n');
  const lines = existing ? existing.split('\n') : [];
  const next: string[] = [];
  let replaced = false;

  for (const line of lines) {
    if (keyPattern.test(line)) {
      if (!replaced) {
        next.push(`${key}=${formatEnvValue(value)}`);
        replaced = true;
      }
      continue;
    }
    next.push(line);
  }

  if (!replaced) {
    if (next.length > 0 && next.at(-1)?.trim()) next.push('');
    next.push(`${key}=${formatEnvValue(value)}`);
  }

  await writeFile(envPath, `${next.join('\n').trimEnd()}\n`, 'utf8');
};
