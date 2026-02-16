export const HOMIE_AI_VERSION: string = '0.0.0';

export { runCliChat } from './channels/cli.js';
export type { LoadedHomieConfig } from './config/load.js';
export { loadHomieConfig } from './config/load.js';
export type { HomieConfig } from './config/types.js';
export { loadIdentityPackage } from './identity/load.js';
export { composeIdentityPrompt } from './identity/prompt.js';
export type { IdentityPackage } from './identity/types.js';
export type { ProviderRegistry, ResolvedModelRole } from './llm/registry.js';
export { createProviderRegistry } from './llm/registry.js';
export { SqliteMemoryLiteStore } from './memory/sqlite-lite.js';
export type { MemoryStore } from './memory/store.js';
export { createToolRegistry, getToolsForTier } from './tools/registry.js';
export type { ToolRegistry, ToolTier } from './tools/types.js';
export type { ChatId, GroupId, MessageId, UserId } from './types/ids.js';
export { asChatId, asGroupId, asMessageId, asUserId } from './types/ids.js';
