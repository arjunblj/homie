import type { IncomingMessage } from '../agent/types.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { OutgoingAction } from '../engine/types.js';
import type { SessionMessage } from '../session/types.js';
import type { ChatId } from '../types/ids.js';

export interface AgentHooks {
  onBootstrap?(ctx: { config: OpenhomieConfig }): Promise<void>;

  onBeforeGenerate?(ctx: {
    chatId: ChatId;
    messages: SessionMessage[];
    isGroup: boolean;
  }): Promise<void>;

  onTurnComplete?(ctx: {
    chatId: ChatId;
    action: OutgoingAction;
    userText: string;
    responseText?: string | undefined;
    isGroup: boolean;
    incomingMessages?: readonly IncomingMessage[] | undefined;
  }): Promise<void>;

  onSessionEnd?(ctx: {
    chatId: ChatId;
    transcript: readonly SessionMessage[];
    summary: string;
  }): Promise<void>;

  onError?(ctx: { chatId?: ChatId | undefined; error: Error }): Promise<void>;
}
