import { Bot } from 'grammy';

import { PerKeyLock } from '../agent/lock.js';
import type { IncomingMessage } from '../agent/types.js';
import { randomDelayMs } from '../behavior/timing.js';
import type { HomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { errorFields, log } from '../util/logger.js';

export interface TelegramConfig {
  token: string;
  operatorUserId?: string | undefined;
}

const resolveTelegramConfig = (env: NodeJS.ProcessEnv): TelegramConfig => {
  interface TgEnv extends NodeJS.ProcessEnv {
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_OPERATOR_USER_ID?: string;
  }
  const e = env as TgEnv;
  const token = e.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('Telegram adapter requires TELEGRAM_BOT_TOKEN.');
  const operatorUserId = e.TELEGRAM_OPERATOR_USER_ID?.trim();
  return { token, operatorUserId };
};

export interface RunTelegramAdapterOptions {
  config: HomieConfig;
  engine: TurnEngine;
  feedback?: FeedbackTracker | undefined;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
}

export const runTelegramAdapter = async ({
  config,
  engine,
  feedback,
  env,
  signal,
}: RunTelegramAdapterOptions): Promise<void> => {
  const logger = log.child({ component: 'telegram' });
  const tgCfg = resolveTelegramConfig(env ?? process.env);
  const bot = new Bot(tgCfg.token);
  const chatQueue = new PerKeyLock<string>();

  if (signal?.aborted) return;
  signal?.addEventListener(
    'abort',
    () => {
      bot.stop();
    },
    { once: true },
  );

  bot.on('message:text', async (ctx) => {
    const chat = ctx.chat;
    const chatId = asChatId(`tg:${chat.id}`);
    const chatKey = String(chatId);
    try {
      await chatQueue.runExclusive(chatKey, async () => {
        if (signal?.aborted) return;
        const isGroup = chat.type === 'group' || chat.type === 'supergroup';
        const authorId = String(ctx.from?.id ?? 'unknown');
        const authorDisplayName = [ctx.from?.first_name, ctx.from?.last_name]
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .join(' ')
          .trim();
        const text = ctx.message.text.trim();
        if (!text) return;

        const isOperator = tgCfg.operatorUserId ? authorId === tgCfg.operatorUserId : false;

        // In groups, only respond if mentioned or replied to.
        let mentioned = false;
        let replied = false;
        if (isGroup) {
          const botInfo = ctx.me;
          mentioned =
            ctx.message.entities?.some(
              (e) =>
                e.type === 'mention' &&
                text.slice(e.offset, e.offset + e.length) === `@${botInfo.username}`,
            ) ?? false;
          replied = ctx.message.reply_to_message?.from?.id === botInfo.id;
          if (!mentioned && !replied) return;
        }

        const msg: IncomingMessage = {
          channel: 'telegram',
          chatId,
          messageId: asMessageId(`tg:${ctx.message.message_id}`),
          authorId,
          ...(authorDisplayName ? { authorDisplayName } : {}),
          text,
          isGroup,
          isOperator,
          mentioned: isGroup ? mentioned || replied : true,
          timestampMs: ctx.message.date * 1000,
        };

        feedback?.onIncomingReply({
          channel: 'telegram',
          chatId,
          authorId,
          text,
          replyToRefKey: ctx.message.reply_to_message?.message_id
            ? makeOutgoingRefKey(chatId, {
                channel: 'telegram',
                messageId: ctx.message.reply_to_message.message_id,
              })
            : undefined,
          timestampMs: msg.timestampMs,
        });

        // Telegram supports a typing indicator; show it while the harness runs.
        let typingTimer: ReturnType<typeof setInterval> | undefined;
        if (!isGroup) {
          const tick = (): void => {
            void ctx.replyWithChatAction('typing').catch((err) => {
              void err;
            });
          };
          tick();
          typingTimer = setInterval(tick, 4000);
        }

        try {
          const out = await engine.handleIncomingMessage(msg);
          switch (out.kind) {
            case 'send_text': {
              if (!out.text) break;
              const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
              if (delay > 0) await new Promise((r) => setTimeout(r, delay));
              const sent = await ctx.reply(out.text);
              feedback?.onOutgoingSent({
                channel: 'telegram',
                chatId,
                refKey: makeOutgoingRefKey(chatId, {
                  channel: 'telegram',
                  messageId: sent.message_id,
                }),
                isGroup,
                sentAtMs: Date.now(),
                text: out.text,
                primaryChannelUserId: `${msg.channel}:${msg.authorId}`,
              });
              break;
            }
            case 'react':
            case 'silence':
              break;
            default:
              assertNever(out);
          }
        } finally {
          if (typingTimer) clearInterval(typingTimer);
        }
      });
    } catch (err) {
      logger.error('handler.error', errorFields(err));
    }
  });

  bot.on('message_reaction', async (ctx) => {
    try {
      const upd = ctx.update.message_reaction;
      if (!upd) return;
      const chatRawId = upd.chat?.id;
      if (chatRawId == null) return;
      const chatId = asChatId(`tg:${chatRawId}`);
      const chatKey = String(chatId);

      await chatQueue.runExclusive(chatKey, async () => {
        if (signal?.aborted) return;
        const ts = typeof upd.date === 'number' ? upd.date * 1000 : Date.now();
        const actorId =
          upd.user?.id != null
            ? String(upd.user.id)
            : upd.actor_chat?.id != null
              ? String(upd.actor_chat.id)
              : undefined;
        const oldEmojis = extractEmojiList(upd.old_reaction);
        const newEmojis = extractEmojiList(upd.new_reaction);

        const added = newEmojis.filter((e: string) => !oldEmojis.includes(e));
        const removed = oldEmojis.filter((e: string) => !newEmojis.includes(e));
        const targetRefKey = makeOutgoingRefKey(chatId, {
          channel: 'telegram',
          messageId: upd.message_id,
        });

        for (const emoji of added) {
          feedback?.onIncomingReaction({
            channel: 'telegram',
            chatId,
            targetRefKey,
            emoji,
            isRemove: false,
            authorId: actorId,
            timestampMs: ts,
          });
        }
        for (const emoji of removed) {
          feedback?.onIncomingReaction({
            channel: 'telegram',
            chatId,
            targetRefKey,
            emoji,
            isRemove: true,
            authorId: actorId,
            timestampMs: ts,
          });
        }
      });
    } catch (err) {
      logger.error('reaction_handler.error', errorFields(err));
    }
  });

  bot.catch((err) => {
    logger.error('unhandled', errorFields(err));
  });

  logger.info('starting');
  await bot.start({
    allowed_updates: ['message', 'message_reaction', 'message_reaction_count'],
  });
};

const extractEmoji = (reaction: unknown): string | null => {
  if (!reaction || typeof reaction !== 'object') return null;
  const r = reaction as { type?: unknown; emoji?: unknown };
  if (r.type === 'emoji' && typeof r.emoji === 'string' && r.emoji.trim()) return r.emoji;
  if (typeof r.emoji === 'string' && r.emoji.trim()) return r.emoji;
  return null;
};

const extractEmojiList = (arr: unknown): string[] => {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const r of arr) {
    const e = extractEmoji(r);
    if (e) out.push(e);
  }
  return out;
};
