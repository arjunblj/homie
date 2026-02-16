#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const color = (code: number, s: string): string => `\u001b[${code}m${s}\u001b[0m`;

const ask = (rl: readline.Interface, question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(color(36, question), (answer) => resolve(answer.trim()));
  });
};

const HOMIE_TOML: string = `[model]
provider = "anthropic"
default = "claude-sonnet-4-5"
fast = "claude-haiku-4-5"

[behavior]
timezone = "UTC"
sleep_mode = true
`;

const SOUL_TEMPLATE: string = `# Soul

Write who this person is. Not what they do, who they are.

Think about:
- How do they see the world?
- What do they care about?
- What makes them laugh?
- What would they never say?
`;

const STYLE_TEMPLATE: string = `# Style

How does this person talk? Short sentences? Long ones? Slang? Dry humor?

## Example exchanges

USER: hey what's up
FRIEND: nm just woke up lol

USER: what do you think about AI?
FRIEND: honestly it's a tool. some people act like it's a person, which is weird
`;

const USER_TEMPLATE: string = `# User

What does this friend know about you?

- Your name
- Where you live
- What you do
- Shared history or inside jokes
`;

const PERSONALITY_JSON: string = JSON.stringify(
  {
    traits: ['dry humor', 'direct', 'warm when it counts'],
    voiceRules: ['no exclamation marks unless genuinely excited', 'lowercase preferred'],
    antiPatterns: ['never say "I hope this helps"', 'never use em dashes'],
  },
  null,
  2,
);

const FIRST_MEETING: string = `Hey. I'm [name]. [Operator] told me about you.
What's your deal?
`;

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const targetDir = args[0];

  if (!targetDir || targetDir === '--help' || targetDir === '-h') {
    process.stdout.write(`Usage: bun create homie <directory>\n`);
    process.exit(targetDir ? 0 : 1);
  }

  const dir = path.resolve(targetDir);

  if (existsSync(dir)) {
    process.stderr.write(`${dir} already exists\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  process.stdout.write(color(90, '\ncreate-homie\n\n'));

  const friendName = (await ask(rl, "What's your friend's name? ")) || 'unnamed';
  const timezone = (await ask(rl, 'Timezone? (e.g. America/New_York) [UTC] ')) || 'UTC';
  const provider =
    (await ask(rl, 'Model provider? (anthropic/openrouter/ollama) [anthropic] ')) || 'anthropic';

  rl.close();

  mkdirSync(path.join(dir, 'identity'), { recursive: true });
  mkdirSync(path.join(dir, 'data'), { recursive: true });

  const toml = HOMIE_TOML.replace('timezone = "UTC"', `timezone = "${timezone}"`).replace(
    'provider = "anthropic"',
    `provider = "${provider}"`,
  );

  writeFileSync(path.join(dir, 'homie.toml'), toml);
  writeFileSync(path.join(dir, 'identity', 'SOUL.md'), SOUL_TEMPLATE);
  writeFileSync(path.join(dir, 'identity', 'STYLE.md'), STYLE_TEMPLATE);
  writeFileSync(path.join(dir, 'identity', 'USER.md'), USER_TEMPLATE);
  writeFileSync(path.join(dir, 'identity', 'personality.json'), PERSONALITY_JSON);
  writeFileSync(
    path.join(dir, 'identity', 'first-meeting.md'),
    FIRST_MEETING.replace('[name]', friendName),
  );
  writeFileSync(path.join(dir, '.env'), `# ANTHROPIC_API_KEY=sk-...\n`);
  writeFileSync(path.join(dir, '.gitignore'), `.env\ndata/\nnode_modules/\n`);

  process.stdout.write(
    [
      '',
      color(32, `Created ${friendName} at ${dir}`),
      '',
      `  cd ${targetDir}`,
      `  # edit identity/SOUL.md and STYLE.md`,
      `  # set your API key in .env`,
      `  bunx homie chat`,
      '',
    ].join('\n'),
  );
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`create-homie: ${msg}\n`);
  process.exit(1);
});
