import { z } from 'zod';

import { defineTool } from './define.js';
import type { ToolDef } from './types.js';

const NoteKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._:-]+$/u, 'Expected key to match /^[a-zA-Z0-9._:-]+$/');

const WriteNoteInputSchema = z.object({
  key: NoteKeySchema.describe('Namespace key for the note (e.g. notes.todo, last_task)'),
  content: z.string().min(1).max(200_000).describe('Note content (markdown ok).'),
});

export const writeNoteTool: ToolDef = defineTool({
  name: 'write_note',
  tier: 'safe',
  description: 'Write a small per-chat scratchpad note (durable across compaction).',
  inputSchema: WriteNoteInputSchema,
  execute: ({ key, content }, ctx) => {
    const chatId = ctx.chat?.chatId;
    const store = ctx.services?.sessionStore;
    if (!chatId || !store) {
      return { status: 'unavailable' as const, reason: 'missing_session_store_or_chat' as const };
    }

    const res = store.upsertNote({ chatId, key, content, nowMs: ctx.now.getTime() });
    return {
      status: 'ok' as const,
      key: res.note.key,
      updatedAtMs: res.note.updatedAtMs,
      truncated: res.truncated,
      ...(res.evictedKey ? { evictedKey: res.evictedKey } : {}),
    };
  },
});

const ReadNotesInputSchema = z.object({
  key: NoteKeySchema.optional().describe('If provided, return only this note key.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max notes to return when key is not provided.'),
});

export const readNotesTool: ToolDef = defineTool({
  name: 'read_notes',
  tier: 'safe',
  description: 'Read per-chat scratchpad notes.',
  inputSchema: ReadNotesInputSchema,
  execute: ({ key, limit }, ctx) => {
    const chatId = ctx.chat?.chatId;
    const store = ctx.services?.sessionStore;
    if (!chatId || !store) {
      return { status: 'unavailable' as const, reason: 'missing_session_store_or_chat' as const };
    }

    if (key) {
      const note = store.getNote(chatId, key);
      if (!note) return { status: 'not_found' as const, key };
      return {
        status: 'ok' as const,
        notes: [{ key: note.key, content: note.content, updatedAtMs: note.updatedAtMs }],
      };
    }

    const notes = store.listNotes(chatId, limit ?? 50).map((n) => ({
      key: n.key,
      content: n.content,
      updatedAtMs: n.updatedAtMs,
    }));
    return { status: 'ok' as const, notes };
  },
});
