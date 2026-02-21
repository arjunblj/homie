import { readFile, writeFile } from 'node:fs/promises';

export const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

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
        next.push(`${key}=${value}`);
        replaced = true;
      }
      continue;
    }
    next.push(line);
  }

  if (!replaced) {
    if (next.length > 0 && next.at(-1)?.trim()) next.push('');
    next.push(`${key}=${value}`);
  }

  await writeFile(envPath, `${next.join('\n').trimEnd()}\n`, 'utf8');
};
