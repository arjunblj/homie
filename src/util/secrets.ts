import { readFileSync } from 'node:fs';

export const resolveSecret = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const direct = env[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const filePath = env[`${key}_FILE`];
  if (typeof filePath !== 'string' || !filePath.trim()) return undefined;
  try {
    const raw = readFileSync(filePath.trim(), 'utf8');
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  } catch (_err) {
    return undefined;
  }
};
