import readline from 'node:readline';
import type { AgentRuntime } from '../agent/runtime.js';
import type { IncomingMessage } from '../agent/types.js';
import { randomDelayMs } from '../behavior/timing.js';
import type { HomieConfig } from '../config/types.js';
import { asChatId, asMessageId } from '../types/ids.js';

const color = (code: number, s: string): string => `\u001b[${code}m${s}\u001b[0m`;

export interface RunCliChatOptions {
  config: HomieConfig;
  runtime: AgentRuntime;
}

export const runCliChat = async ({ config, runtime }: RunCliChatOptions): Promise<void> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const chatId = asChatId('cli:local');
  let seq = 0;

  const prompt = (): void => {
    rl.setPrompt(color(90, '> '));
    rl.prompt();
  };

  process.stdout.write(color(90, 'homie (cli) — type /exit to quit\n'));
  prompt();

  rl.on('line', async (line) => {
    const text = line.trimEnd();
    if (text === '/exit' || text === '/quit') {
      rl.close();
      return;
    }

    seq += 1;
    const msg: IncomingMessage = {
      channel: 'cli',
      chatId,
      messageId: asMessageId(`cli:${seq}`),
      authorId: 'operator',
      text,
      isGroup: false,
      isOperator: true,
      timestampMs: Date.now(),
    };

    try {
      const out = await runtime.handleIncomingMessage(msg);
      if (out?.text) {
        const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        process.stdout.write(`${color(36, 'homie:')} ${out.text}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(color(31, `error: ${msg}\n`));
    } finally {
      prompt();
    }
  });

  await new Promise<void>((resolve) => rl.once('close', resolve));
};
