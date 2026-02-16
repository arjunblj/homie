import type { HomieConfig } from '../config/types.js';
import type { IncomingMessage, OutgoingMessage } from './types.js';
import type { LLMBackend } from '../backend/types.js';
import type { ToolDef } from '../tools/types.js';
import { TurnEngine } from '../engine/turnEngine.js';

export interface AgentRuntimeOptions {
  config: HomieConfig;
  backend: LLMBackend;
  tools?: readonly ToolDef[] | undefined;
}

/**
 * @deprecated Prefer `TurnEngine`, which returns structured actions (send/react/silence).
 * This wrapper is kept for compatibility with early homie versions.
 */
export class AgentRuntime {
  private readonly engine: TurnEngine;

  public constructor(options: AgentRuntimeOptions) {
    this.engine = new TurnEngine({
      config: options.config,
      backend: options.backend,
      tools: options.tools,
    });
  }

  public async handleIncomingMessage(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    const action = await this.engine.handleIncomingMessage(msg);
    if (action.kind !== 'send_text' || !action.text) return null;
    return { channel: msg.channel, chatId: msg.chatId, text: action.text };
  }
}
