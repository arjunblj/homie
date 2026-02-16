import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const isDirectory = async (filePath: string): Promise<boolean> => {
  try {
    const s = await stat(filePath);
    return s.isDirectory();
  } catch {
    return false;
  }
};

export const readTextFile = async (filePath: string): Promise<string> => {
  return readFile(filePath, 'utf8');
};

export const findUp = async (filename: string, startDir: string): Promise<string | null> => {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, filename);
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};
