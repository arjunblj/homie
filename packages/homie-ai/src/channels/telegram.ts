import { Bot } from 'grammy';

import type { IncomingMessage } from '../agent/types.js';
import { randomDelayMs } from '../behavior/timing.js';
import type { HomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';

export interface TelegramConfig {
  token: string;
  operatorChatId?: string | undefined;
}

const resolveTelegramConfig = (env: NodeJS.ProcessEnv): TelegramConfig => {
  interface TgEnv extends NodeJS.ProcessEnv {
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_OPERATOR_CHAT_ID?: string;
  }
  const e = env as TgEnv;
  const token = e.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('Telegram adapter requires TELEGRAM_BOT_TOKEN.');
  return { token, operatorChatId: e.TELEGRAM_OPERATOR_CHAT_ID?.trim() };
};

export interface RunTelegramAdapterOptions {
  config: HomieConfig;
  engine: TurnEngine;
  env?: NodeJS.ProcessEnv;
}

export const runTelegramAdapter = async ({
  config,
  engine,
  env,
}: RunTelegramAdapterOptions): Promise<void> => {
  const tgCfg = resolveTelegramConfig(env ?? process.env);
  const bot = new Bot(tgCfg.token);

  bot.on('message:text', async (ctx) => {
    try {
      const chat = ctx.chat;
      const isGroup = chat.type === 'group' || chat.type === 'supergroup';
      const chatId = asChatId(`tg:${chat.id}`);
      const authorId = String(ctx.from?.id ?? 'unknown');
      const text = ctx.message.text.trim();
      if (!text) return;

      const isOperator = tgCfg.operatorChatId
        ? String(ctx.from?.id) === tgCfg.operatorChatId
        : false;

      // In groups, only respond if mentioned or replied to.
      if (isGroup) {
        const botInfo = ctx.me;
        const mentioned =
          ctx.message.entities?.some(
            (e) =>
              e.type === 'mention' &&
              text.slice(e.offset, e.offset + e.length) === `@${botInfo.username}`,
          ) ?? false;
        const replied = ctx.message.reply_to_message?.from?.id === botInfo.id;
        if (!mentioned && !replied) return;
      }

      const msg: IncomingMessage = {
        channel: 'telegram',
        chatId,
        messageId: asMessageId(`tg:${ctx.message.message_id}`),
        authorId,
        text,
        isGroup,
        isOperator,
        mentioned: true,
        timestampMs: ctx.message.date * 1000,
      };

      const out = await engine.handleIncomingMessage(msg);
      switch (out.kind) {
        case 'send_text': {
          if (!out.text) break;
          const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          await ctx.reply(out.text);
          break;
        }
        case 'react':
        case 'silence':
          break;
        default:
          assertNever(out);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[telegram] error: ${errMsg}\n`);
    }
  });

  bot.catch((err) => {
    process.stderr.write(`[telegram] unhandled: ${err.message}\n`);
  });

  process.stdout.write('[telegram] starting long polling\n');
  await bot.start();
};
