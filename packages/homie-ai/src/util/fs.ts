import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    throw err;
  }
};

export const isDirectory = async (filePath: string): Promise<boolean> => {
  try {
    const s = await stat(filePath);
    return s.isDirectory();
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    throw err;
  }
};

export const readTextFile = async (filePath: string): Promise<string> => {
  return readFile(filePath, 'utf8');
};

export const openUrl = async (url: string): Promise<boolean> => {
  const cmd =
    process.platform === 'darwin'
      ? { name: 'open', args: [url] }
      : process.platform === 'win32'
        ? { name: 'cmd', args: ['/c', 'start', '', url] }
        : { name: 'xdg-open', args: [url] };
  return await new Promise((resolve) => {
    execFile(cmd.name, cmd.args, (error) => resolve(!error));
  });
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
