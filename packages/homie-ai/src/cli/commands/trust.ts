import type { LoadedHomieConfig } from '../../config/load.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { ChatTrustTierSchema, deriveTrustTierForPerson } from '../../memory/types.js';
import type { GlobalOpts } from '../args.js';

export async function runTrustCommand(
  opts: GlobalOpts,
  cmdArgs: readonly string[],
  loadCfg: () => Promise<LoadedHomieConfig>,
  trustHelp: () => string,
): Promise<void> {
  const sub = (cmdArgs[0] ?? 'list').trim();
  const loaded = await loadCfg();
  const memStore = new SqliteMemoryStore({
    dbPath: `${loaded.config.paths.dataDir}/memory.db`,
  });
  try {
    if (sub === 'list') {
      const people = await memStore.listPeople(500, 0);
      const overridden = people.filter((p) => Boolean(p.trustTierOverride));
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ overridden }, null, 2)}\n`);
      } else if (overridden.length === 0) {
        process.stdout.write('No trust overrides set.\n');
      } else {
        process.stdout.write(`Trust overrides (${overridden.length}):\n`);
        for (const p of overridden) {
          const eff = deriveTrustTierForPerson(p);
          process.stdout.write(
            `- ${p.displayName} (${p.channelUserId}) override=${p.trustTierOverride} effective=${eff} score=${p.relationshipScore.toFixed(2)}\n`,
          );
        }
      }
    } else if (sub === 'set') {
      const channelUserId = cmdArgs[1]?.trim();
      const tierRaw = cmdArgs[2]?.trim();
      if (!channelUserId || !tierRaw) {
        process.stderr.write(
          'homie trust set: usage: homie trust set <channelUserId> <new_contact|getting_to_know|close_friend>\n',
        );
        process.exit(1);
      }
      const tierParsed = ChatTrustTierSchema.safeParse(tierRaw);
      if (!tierParsed.success) {
        process.stderr.write(`homie trust set: invalid tier "${tierRaw}"\n`);
        process.exit(1);
      }
      const person = await memStore.getPersonByChannelId(channelUserId);
      if (!person) {
        const suggestions = await memStore.searchPeople(channelUserId);
        process.stderr.write(`homie trust set: unknown person "${channelUserId}"\n`);
        if (suggestions.length > 0) {
          process.stderr.write('Did you mean:\n');
          for (const s of suggestions.slice(0, 5)) {
            process.stderr.write(`- ${s.displayName} (${s.channelUserId})\n`);
          }
        }
        process.exit(1);
      }
      await memStore.setTrustTierOverride(person.id, tierParsed.data);
      const updated = await memStore.getPerson(String(person.id));
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ person: updated }, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Set trust override: ${person.displayName} (${person.channelUserId}) -> ${tierParsed.data}\n`,
        );
      }
    } else if (sub === 'clear') {
      const channelUserId = cmdArgs[1]?.trim();
      if (!channelUserId) {
        process.stderr.write('homie trust clear: usage: homie trust clear <channelUserId>\n');
        process.exit(1);
      }
      const person = await memStore.getPersonByChannelId(channelUserId);
      if (!person) {
        process.stderr.write(`homie trust clear: unknown person "${channelUserId}"\n`);
        process.exit(1);
      }
      await memStore.setTrustTierOverride(person.id, null);
      if (!opts.json) {
        process.stdout.write(
          `Cleared trust override: ${person.displayName} (${person.channelUserId})\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify({ ok: true }, null, 2)}\n`);
      }
    } else {
      process.stderr.write(`homie trust: unknown subcommand "${sub}"\n`);
      process.stderr.write(`${trustHelp()}\n`);
      process.exit(1);
    }
  } finally {
    memStore.close();
  }
}
