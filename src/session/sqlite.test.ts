import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId } from '../types/ids.js';
import { SqliteSessionStore } from './sqlite.js';

describe('SqliteSessionStore', () => {
  test('migrates legacy DBs by adding author columns', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-migrate-'));
    try {
      const dbPath = path.join(dir, 'session.db');

      // Simulate a v1 DB that predates author metadata columns.
      const db = new Database(dbPath, { strict: true });
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(
        `
CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES sessions(chat_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_messages_chat_id_id
  ON session_messages(chat_id, id);
`,
      );
      db.exec('PRAGMA user_version = 1;');
      db.close();

      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');
      const now = Date.now();
      store.appendMessage({
        chatId,
        role: 'user',
        content: 'hello',
        createdAtMs: now,
        authorId: 'u1',
        authorDisplayName: 'Arjun',
        sourceMessageId: 'telegram:123',
      });

      const msgs = store.getMessages(chatId, 10);
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.authorId).toBe('u1');
      expect(msgs[0]?.authorDisplayName).toBe('Arjun');
      expect(msgs[0]?.sourceMessageId).toBe('telegram:123');
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('roundtrips author metadata and attachments for user messages', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-authors-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');
      const now = Date.now();

      store.appendMessage({
        chatId,
        role: 'user',
        content: 'hello',
        createdAtMs: now,
        authorId: 'u1',
        authorDisplayName: 'Arjun',
        sourceMessageId: 'telegram:123',
        attachments: [
          {
            id: 'a1',
            kind: 'image',
            mime: 'image/jpeg',
            sizeBytes: 123,
            derivedText: 'caption',
          },
        ],
      });

      const msgs = store.getMessages(chatId, 10);
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.role).toBe('user');
      expect(msgs[0]?.authorId).toBe('u1');
      expect(msgs[0]?.authorDisplayName).toBe('Arjun');
      expect(msgs[0]?.sourceMessageId).toBe('telegram:123');
      expect(msgs[0]?.attachments?.[0]?.kind).toBe('image');
      expect(msgs[0]?.attachments?.[0]?.derivedText).toBe('caption');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('compacts and injects persona reminder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');

      for (let i = 0; i < 50; i += 1) {
        store.appendMessage({
          chatId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i} ${'x'.repeat(40)}`,
          createdAtMs: Date.now() + i,
        });
      }
      const before = store.getMessages(chatId, 1000).length;

      const did = await store.compactIfNeeded({
        chatId,
        maxTokens: 200,
        personaReminder: 'Traits: dry',
        summarize: async () => 'summary',
      });
      expect(did).toBe(true);

      const msgs = store.getMessages(chatId, 500);
      expect(msgs.length).toBeLessThan(before);
      const all = msgs.map((m) => m.content).join('\n');
      expect(all).toContain('=== CONVERSATION SUMMARY ===');
      expect(all).toContain('=== PERSONA REMINDER ===');
      expect(all).toContain('Traits: dry');

      // Smoke coverage for the estimateTokens helper.
      expect(store.estimateTokens(chatId)).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('preserves author metadata through compaction', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-compact-meta-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');
      const now = Date.now();

      for (let i = 0; i < 50; i += 1) {
        store.appendMessage({
          chatId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i} ${'x'.repeat(40)}`,
          createdAtMs: now + i,
          ...(i % 2 === 0
            ? { authorId: `u${i}`, authorDisplayName: `User${i}`, sourceMessageId: `m${i}` }
            : {}),
        });
      }
      const before = store.getMessages(chatId, 1000).length;

      const did = await store.compactIfNeeded({
        chatId,
        maxTokens: 200,
        personaReminder: 'Traits: dry',
        summarize: async () => 'summary',
      });
      expect(did).toBe(true);

      const msgs = store.getMessages(chatId, 500);
      expect(msgs.length).toBeLessThan(before);
      const userMsgs = msgs.filter((m) => m.role === 'user');
      for (const m of userMsgs) {
        expect(m.authorId).toBeDefined();
        expect(m.authorDisplayName).toBeDefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not delete messages when summarize throws', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-summarize-throws-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');

      for (let i = 0; i < 50; i += 1) {
        store.appendMessage({
          chatId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i} ${'x'.repeat(40)}`,
          createdAtMs: Date.now() + i,
        });
      }

      const before = store.getMessages(chatId, 1000);
      const did = await store.compactIfNeeded({
        chatId,
        maxTokens: 200,
        personaReminder: 'Traits: dry',
        summarize: async () => {
          throw new Error('boom');
        },
      });
      expect(did).toBe(false);

      const after = store.getMessages(chatId, 1000);
      expect(after.length).toBe(before.length);
      expect(after[0]?.content).toBe(before[0]?.content);
      expect(after.at(-1)?.content).toBe(before.at(-1)?.content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('compaction does not delete messages appended during summarize', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-compact-concurrent-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');

      for (let i = 0; i < 50; i += 1) {
        store.appendMessage({
          chatId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i} ${'x'.repeat(40)}`,
          createdAtMs: Date.now() + i,
        });
      }

      let release: (() => void) | undefined;
      const summarizeBlocked = new Promise<void>((r) => {
        release = r;
      });
      let enteredResolve: (() => void) | undefined;
      const summarizeEntered = new Promise<void>((r) => {
        enteredResolve = r;
      });
      let summarizeCalls = 0;

      const compactPromise = store.compactIfNeeded({
        chatId,
        maxTokens: 200,
        personaReminder: 'Traits: dry',
        summarize: async () => {
          summarizeCalls += 1;
          enteredResolve?.();
          await summarizeBlocked;
          return 'summary';
        },
      });

      // While compaction is paused inside summarize(...), append more messages.
      await summarizeEntered;
      const appendedDuring = `appended_during_${Date.now()}`;
      for (let i = 0; i < 10; i += 1) {
        store.appendMessage({
          chatId,
          role: 'user',
          content: `${appendedDuring}:${i}`,
          createdAtMs: Date.now() + 1000 + i,
        });
      }

      release?.();
      const didCompact = await compactPromise;
      expect(didCompact).toBe(true);
      expect(summarizeCalls).toBe(1);

      const after = store.getMessages(chatId, 500).map((m) => m.content);
      // New messages appended during summarize should survive the deleteRange transaction.
      expect(after.join('\n')).toContain(`${appendedDuring}:9`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('upsertNote/getNote/listNotes roundtrip with truncation and key caps', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-session-notes-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');
      const now = Date.now();

      const wrote = store.upsertNote({ chatId, key: 'k1', content: 'hello', nowMs: now });
      expect(wrote.note.key).toBe('k1');
      expect(wrote.note.content).toBe('hello');
      expect(wrote.truncated).toBe(false);

      const fetched = store.getNote(chatId, 'k1');
      expect(fetched?.content).toBe('hello');

      const huge = 'x'.repeat(40_000);
      const wroteHuge = store.upsertNote({ chatId, key: 'huge', content: huge, nowMs: now + 1 });
      expect(wroteHuge.truncated).toBe(true);
      expect(wroteHuge.note.content.length).toBeLessThan(huge.length);

      // Fill over the key cap and ensure we evict something instead of growing unbounded.
      let lastEvicted: string | undefined;
      for (let i = 0; i < 80; i += 1) {
        const res = store.upsertNote({
          chatId,
          key: `k_${i}`,
          content: `v_${i}`,
          nowMs: now + 2 + i,
        });
        if (res.evictedKey) lastEvicted = res.evictedKey;
      }
      const notes = store.listNotes(chatId, 500);
      expect(notes.length).toBeLessThanOrEqual(64);
      expect(lastEvicted).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
