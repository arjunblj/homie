import type { LoadedOpenhomieConfig } from '../../config/load.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';

export async function runExportCommand(
  loadCfg: () => Promise<LoadedOpenhomieConfig>,
): Promise<void> {
  const loaded = await loadCfg();
  const memStore = new SqliteMemoryStore({
    dbPath: `${loaded.config.paths.dataDir}/memory.db`,
  });
  const data = await memStore.exportJson();
  memStore.close();
  process.stdout.write(JSON.stringify(data, null, 2));
  process.stdout.write('\n');
}
