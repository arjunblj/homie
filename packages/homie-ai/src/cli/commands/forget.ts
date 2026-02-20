import type { LoadedHomieConfig } from '../../config/load.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';

export async function runForgetCommand(
  cmdArgs: readonly string[],
  loadCfg: () => Promise<LoadedHomieConfig>,
): Promise<void> {
  const personId = cmdArgs[0];
  if (!personId) {
    process.stderr.write('homie forget: missing person ID\n');
    process.exit(1);
  }
  const loaded = await loadCfg();
  const memStore = new SqliteMemoryStore({
    dbPath: `${loaded.config.paths.dataDir}/memory.db`,
  });
  await memStore.deletePerson(personId);
  memStore.close();
  process.stdout.write(`Deleted person "${personId}" and associated facts.\n`);
}
