import { describe, expect, test } from 'bun:test';

import { asChatId } from '../types/ids.js';
import type { Logger } from '../util/logger.js';
import { HookRegistry } from './registry.js';

const makeNoopLogger = (): Logger => {
  const base: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return base;
    },
  };
  return base;
};

describe('HookRegistry', () => {
  test('isolates hook failures and continues emitting', async () => {
    const reg = new HookRegistry(makeNoopLogger());
    let onErrorCalled = 0;
    let hook2Called = 0;

    reg.register({
      onBeforeGenerate: async () => {
        throw new Error('boom');
      },
      onError: async () => {
        onErrorCalled += 1;
      },
    });
    reg.register({
      onBeforeGenerate: async () => {
        hook2Called += 1;
      },
    });

    await reg.emit('onBeforeGenerate', {
      chatId: asChatId('cli:local'),
      messages: [],
      isGroup: false,
    });
    expect(onErrorCalled).toBe(1);
    expect(hook2Called).toBe(1);
  });

  test('isolates onError failures', async () => {
    const reg = new HookRegistry(makeNoopLogger());
    let hook2Called = 0;

    reg.register({
      onBeforeGenerate: async () => {
        throw new Error('boom');
      },
      onError: async () => {
        throw new Error('boom2');
      },
    });
    reg.register({
      onBeforeGenerate: async () => {
        hook2Called += 1;
      },
    });

    await reg.emit('onBeforeGenerate', {
      chatId: asChatId('cli:local'),
      messages: [],
      isGroup: false,
    });
    expect(hook2Called).toBe(1);
  });
});
