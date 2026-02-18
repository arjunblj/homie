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
});
