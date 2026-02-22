import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function assertGolden(
  actual: string,
  goldenPath: string,
  update: boolean = (process.env as NodeJS.ProcessEnv & { UPDATE_GOLDEN?: string })
    .UPDATE_GOLDEN === '1',
): Promise<void> {
  const projectRoot = process.cwd();
  const fullPath = path.isAbsolute(goldenPath) ? goldenPath : path.join(projectRoot, goldenPath);

  if (update) {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, actual, 'utf8');
    return;
  }

  let expected: string;
  try {
    expected = await readFile(fullPath, 'utf8');
  } catch (_err) {
    throw new Error(
      `Golden file not found: ${fullPath}\n` +
        `Run with UPDATE_GOLDEN=1 to create it.\n` +
        `Actual output:\n${actual}`,
    );
  }

  if (actual !== expected) {
    throw new Error(`Golden file mismatch: ${fullPath}\nRun with UPDATE_GOLDEN=1 to update.\n`);
  }
}
