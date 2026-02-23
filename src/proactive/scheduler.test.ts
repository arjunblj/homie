import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId } from '../types/ids.js';
import { EventScheduler } from './scheduler.js';

describe('EventScheduler claiming', () => {
  test('claimPendingEvents only returns due events for windowMs=0', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-sched-'));
    try {
      const dbPath = path.join(tmp, 'proactive.db');
      const scheduler = new EventScheduler({ dbPath });
      const chatId = asChatId('c1');

      scheduler.addEvent({
        kind: 'reminder',
        subject: 'future',
        chatId,
        triggerAtMs: Date.now() + 10_000,
        recurrence: 'once',
        createdAtMs: Date.now(),
      });

      const claimed = scheduler.claimPendingEvents({
        windowMs: 0,
        limit: 10,
        leaseMs: 60_000,
        claimId: 't1',
      });
      expect(claimed).toHaveLength(0);
      scheduler.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('claimPendingEvents is exclusive across instances (lease)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-sched-multi-'));
    try {
      const dbPath = path.join(tmp, 'proactive.db');
      const a = new EventScheduler({ dbPath });
      const b = new EventScheduler({ dbPath });
      const chatId = asChatId('c1');

      a.addEvent({
        kind: 'birthday',
        subject: 'Alice',
        chatId,
        triggerAtMs: Date.now() - 1,
        recurrence: 'yearly',
        createdAtMs: Date.now(),
      });

      const [claimedA, claimedB] = await Promise.all([
        Promise.resolve().then(() =>
          a.claimPendingEvents({
            windowMs: 0,
            limit: 10,
            leaseMs: 60_000,
            claimId: 'a',
          }),
        ),
        Promise.resolve().then(() =>
          b.claimPendingEvents({
            windowMs: 0,
            limit: 10,
            leaseMs: 60_000,
            claimId: 'b',
          }),
        ),
      ]);

      expect(claimedA.length + claimedB.length).toBe(1);
      a.close();
      b.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('releaseClaim allows retry; markDelivered clears pending', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-sched-release-'));
    try {
      const dbPath = path.join(tmp, 'proactive.db');
      const scheduler = new EventScheduler({ dbPath });
      const chatId = asChatId('c1');

      const id = scheduler.addEvent({
        kind: 'reminder',
        subject: 'call mom',
        chatId,
        triggerAtMs: Date.now() - 1,
        recurrence: 'once',
        createdAtMs: Date.now(),
      });
      expect(id).toBeGreaterThan(0);

      const claimed1 = scheduler.claimPendingEvents({
        windowMs: 0,
        limit: 10,
        leaseMs: 60_000,
        claimId: 'c1',
      });
      expect(claimed1.map((e) => e.id)).toEqual([id]);

      scheduler.releaseClaim(id, 'c1');
      const claimed2 = scheduler.claimPendingEvents({
        windowMs: 0,
        limit: 10,
        leaseMs: 60_000,
        claimId: 'c2',
      });
      expect(claimed2.map((e) => e.id)).toEqual([id]);

      scheduler.markDelivered(id, 'c2');
      expect(scheduler.getPendingEvents(0)).toHaveLength(0);
      scheduler.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('counts sends per chat', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-sched-count-'));
    try {
      const dbPath = path.join(tmp, 'proactive.db');
      const scheduler = new EventScheduler({ dbPath });
      const a = asChatId('c:a');
      const b = asChatId('c:b');

      scheduler.logProactiveSend(a, 1);
      scheduler.logProactiveSend(a, 2);
      scheduler.logProactiveSend(b, 3);

      expect(scheduler.countRecentSendsForChat(a, 86_400_000)).toBe(2);
      expect(scheduler.countRecentSendsForChat(b, 86_400_000)).toBe(1);
      scheduler.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('EventScheduler open loops', () => {
  test('resolve clears follow-up event; upsert re-opens', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-openloops-'));
    try {
      const dbPath = path.join(tmp, 'proactive.db');
      const scheduler = new EventScheduler({ dbPath });
      const chatId = asChatId('c1');

      const first = scheduler.upsertOpenLoop({
        chatId,
        subject: 'job interview',
        subjectKey: 'job interview',
        category: 'upcoming_event',
        emotionalWeight: 'medium',
        anchorDateMs: null,
        evidenceQuote: 'interview',
        followUpQuestion: 'how did that interview go?',
        nowMs: 1_000,
      });
      expect(first.openLoopId).toBeGreaterThan(0);

      scheduler.attachFollowUpEventToOpenLoop({
        openLoopId: first.openLoopId,
        followUpEventId: 123,
      });

      const resolved = scheduler.resolveOpenLoop({ chatId, subjectKey: 'job interview', nowMs: 2_000 });
      expect(resolved.resolved).toBe(true);
      expect(resolved.followUpEventId).toBe(123);

      const afterResolve = scheduler
        .listOpenLoopsForChat(chatId, 10)
        .find((l) => l.subjectKey === 'job interview');
      expect(afterResolve?.status).toBe('resolved');
      expect(afterResolve?.followUpEventId).toBeUndefined();

      const second = scheduler.upsertOpenLoop({
        chatId,
        subject: 'job interview',
        subjectKey: 'job interview',
        category: 'upcoming_event',
        emotionalWeight: 'medium',
        anchorDateMs: null,
        evidenceQuote: 'interview again',
        followUpQuestion: 'any news on that interview?',
        nowMs: 3_000,
      });
      expect(second.openLoopId).toBe(first.openLoopId);
      expect(second.followUpEventId).toBeUndefined();

      const afterReopen = scheduler
        .listOpenLoopsForChat(chatId, 10)
        .find((l) => l.subjectKey === 'job interview');
      expect(afterReopen?.status).toBe('open');

      scheduler.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
