import { Bot } from 'grammy';
import type { IncomingAttachment } from '../agent/attachments.js';
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

  const getBytesForFileId = (fileId: string): (() => Promise<Uint8Array>) => {
    return async () => {
      const file = (await bot.api.getFile(fileId)) as { file_path?: string | undefined };
      const filePath = file.file_path;
      if (!filePath) throw new Error('telegram.getFile: missing file_path');
      const url = `https://api.telegram.org/file/bot${tgCfg.token}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`telegram.download_failed status=${res.status}`);
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    };
  };

  type TelegramEntity = { type?: string; offset?: number; length?: number };
  type TelegramInboundCtx = {
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; last_name?: string } | undefined;
    me: { id: number; username: string };
    message: {
      message_id: number;
      date: number;
      text?: string | undefined;
      caption?: string | undefined;
      entities?: TelegramEntity[] | undefined;
      caption_entities?: TelegramEntity[] | undefined;
      reply_to_message?: { from?: { id?: number } | undefined; message_id?: number } | undefined;
      photo?: Array<{ file_id: string; file_size?: number }> | undefined;
      voice?: { file_id?: string; file_size?: number; mime_type?: string } | undefined;
      audio?:
        | {
            file_id?: string;
            file_size?: number;
            mime_type?: string;
            file_name?: string;
            title?: string;
          }
        | undefined;
      document?:
        | { file_id?: string; file_size?: number; mime_type?: string; file_name?: string }
        | undefined;
      video?: { file_id?: string; file_size?: number; mime_type?: string } | undefined;
    };
    replyWithChatAction: (action: 'typing') => Promise<unknown>;
    reply: (text: string) => Promise<{ message_id: number }>;
  };

  const isGroupChat = (type: unknown): boolean => type === 'group' || type === 'supergroup';

  const extractMentioned = (opts: {
    isGroup: boolean;
    text: string;
    entities: TelegramEntity[] | undefined;
    replied: boolean;
    botUsername: string;
  }): boolean => {
    if (!opts.isGroup) return true;
    if (opts.replied) return true;
    const text = opts.text;
    if (!text) return false;
    return (
      opts.entities?.some((e) => {
        if (e.type !== 'mention') return false;
        const offset = typeof e.offset === 'number' ? e.offset : -1;
        const length = typeof e.length === 'number' ? e.length : -1;
        if (offset < 0 || length <= 0) return false;
        return text.slice(offset, offset + length) === `@${opts.botUsername}`;
      }) ?? false
    );
  };

  const handleInbound = async (
    ctx: TelegramInboundCtx,
    opts: { text: string; attachments?: IncomingAttachment[] },
  ): Promise<void> => {
    const chat = ctx.chat;
    const chatId = asChatId(`tg:${chat.id}`);
    const chatKey = String(chatId);

    await chatQueue.runExclusive(chatKey, async () => {
      if (signal?.aborted) return;

      const isGroup = isGroupChat(chat.type);
      const authorId = String(ctx.from?.id ?? 'unknown');
      const authorDisplayName = [ctx.from?.first_name, ctx.from?.last_name]
        .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
        .join(' ')
        .trim();

      const isOperator = tgCfg.operatorUserId ? authorId === tgCfg.operatorUserId : false;

      // In groups, only respond if mentioned or replied to.
      let mentioned = false;
      let replied = false;
      if (isGroup) {
        const botInfo = ctx.me;
        replied = ctx.message.reply_to_message?.from?.id === botInfo.id;
        const entities = ctx.message.entities ?? ctx.message.caption_entities;
        mentioned = extractMentioned({
          isGroup,
          text: opts.text,
          entities,
          replied,
          botUsername: botInfo.username,
        });
        if (!mentioned) return;
      } else {
        mentioned = true;
      }

      const msg: IncomingMessage = {
        channel: 'telegram',
        chatId,
        messageId: asMessageId(`tg:${ctx.message.message_id}`),
        authorId,
        ...(authorDisplayName ? { authorDisplayName } : {}),
        text: opts.text,
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
        isGroup,
        isOperator,
        mentioned,
        timestampMs: ctx.message.date * 1000,
      };

      feedback?.onIncomingReply({
        channel: 'telegram',
        chatId,
        authorId,
        text: opts.text,
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
          void ctx.replyWithChatAction('typing').catch((err: unknown) => {
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
  };

  if (signal?.aborted) return;
  signal?.addEventListener(
    'abort',
    () => {
      bot.stop();
    },
    { once: true },
  );

  bot.on('message:text', async (ctx) => {
    try {
      await handleInbound(ctx, { text: String(ctx.message.text ?? '').trim() });
    } catch (err) {
      logger.error('handler.error', errorFields(err));
    }
  });

  bot.on('message:photo', async (ctx) => {
    try {
      const photos = (ctx.message.photo ?? []) as Array<{ file_id: string; file_size?: number }>;
      const best = photos.at(-1);
      if (!best?.file_id) return;
      const caption = String(ctx.message.caption ?? '').trim();
      const attachments: IncomingAttachment[] = [
        {
          id: `tg:${ctx.message.message_id}:0`,
          kind: 'image',
          mime: 'image/jpeg',
          ...(typeof best.file_size === 'number' ? { sizeBytes: best.file_size } : {}),
          ...(caption ? { derivedText: caption } : {}),
          getBytes: getBytesForFileId(best.file_id),
        },
      ];
      await handleInbound(ctx, { text: caption, attachments });
    } catch (err) {
      logger.error('handler.photo_error', errorFields(err));
    }
  });

  bot.on('message:voice', async (ctx) => {
    try {
      const voice = ctx.message.voice as
        | { file_id?: string; file_size?: number; mime_type?: string }
        | undefined;
      if (!voice?.file_id) return;
      const attachments: IncomingAttachment[] = [
        {
          id: `tg:${ctx.message.message_id}:0`,
          kind: 'audio',
          ...(voice.mime_type ? { mime: voice.mime_type } : {}),
          ...(typeof voice.file_size === 'number' ? { sizeBytes: voice.file_size } : {}),
          getBytes: getBytesForFileId(voice.file_id),
        },
      ];
      await handleInbound(ctx, { text: '', attachments });
    } catch (err) {
      logger.error('handler.voice_error', errorFields(err));
    }
  });

  bot.on('message:audio', async (ctx) => {
    try {
      const audio = ctx.message.audio as
        | {
            file_id?: string;
            file_size?: number;
            mime_type?: string;
            file_name?: string;
            title?: string;
          }
        | undefined;
      if (!audio?.file_id) return;
      const caption = String(ctx.message.caption ?? '').trim();
      const attachments: IncomingAttachment[] = [
        {
          id: `tg:${ctx.message.message_id}:0`,
          kind: 'audio',
          ...(audio.mime_type ? { mime: audio.mime_type } : {}),
          ...(typeof audio.file_size === 'number' ? { sizeBytes: audio.file_size } : {}),
          ...(audio.file_name ? { fileName: audio.file_name } : {}),
          ...(caption ? { derivedText: caption } : {}),
          getBytes: getBytesForFileId(audio.file_id),
        },
      ];
      await handleInbound(ctx, { text: caption, attachments });
    } catch (err) {
      logger.error('handler.audio_error', errorFields(err));
    }
  });

  bot.on('message:document', async (ctx) => {
    try {
      const doc = ctx.message.document as
        | { file_id?: string; file_size?: number; mime_type?: string; file_name?: string }
        | undefined;
      if (!doc?.file_id) return;
      const caption = String(ctx.message.caption ?? '').trim();
      const attachments: IncomingAttachment[] = [
        {
          id: `tg:${ctx.message.message_id}:0`,
          kind: 'file',
          ...(doc.mime_type ? { mime: doc.mime_type } : {}),
          ...(typeof doc.file_size === 'number' ? { sizeBytes: doc.file_size } : {}),
          ...(doc.file_name ? { fileName: doc.file_name } : {}),
          ...(caption ? { derivedText: caption } : {}),
          getBytes: getBytesForFileId(doc.file_id),
        },
      ];
      await handleInbound(ctx, { text: caption, attachments });
    } catch (err) {
      logger.error('handler.document_error', errorFields(err));
    }
  });

  bot.on('message:video', async (ctx) => {
    try {
      const video = ctx.message.video as
        | { file_id?: string; file_size?: number; mime_type?: string }
        | undefined;
      if (!video?.file_id) return;
      const caption = String(ctx.message.caption ?? '').trim();
      const attachments: IncomingAttachment[] = [
        {
          id: `tg:${ctx.message.message_id}:0`,
          kind: 'video',
          ...(video.mime_type ? { mime: video.mime_type } : {}),
          ...(typeof video.file_size === 'number' ? { sizeBytes: video.file_size } : {}),
          ...(caption ? { derivedText: caption } : {}),
          getBytes: getBytesForFileId(video.file_id),
        },
      ];
      await handleInbound(ctx, { text: caption, attachments });
    } catch (err) {
      logger.error('handler.video_error', errorFields(err));
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
