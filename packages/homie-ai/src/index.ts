export const HOMIE_AI_VERSION: string = '0.0.0';

export { AgentRuntime } from './agent/runtime.js';
export { AiSdkBackend } from './backend/ai-sdk.js';
export type { CompleteParams, CompletionResult, LLMBackend } from './backend/types.js';
export type { LoadedHomieConfig } from './config/load.js';
export { loadHomieConfig } from './config/load.js';
export type { HomieConfig, HomieProactiveConfig } from './config/types.js';
export { TurnEngine } from './engine/turnEngine.js';
export type { OutgoingAction } from './engine/types.js';
export { GroupStore } from './groups/store.js';
export { loadIdentityPackage } from './identity/load.js';
export { composeIdentityPrompt } from './identity/prompt.js';
export type { IdentityPackage } from './identity/types.js';
export type { AssembleMemoryContextOptions, MemoryContext } from './memory/context-pack.js';
export { assembleMemoryContext } from './memory/context-pack.js';
export type { Embedder } from './memory/embeddings.js';
export { createEmbedder } from './memory/embeddings.js';
export type { MemoryExtractor, MemoryExtractorDeps } from './memory/extractor.js';
export { createMemoryExtractor } from './memory/extractor.js';
export { SqliteMemoryStore } from './memory/sqlite.js';
export type { MemoryStore } from './memory/store.js';
export type {
  Episode,
  Fact,
  FactCategory,
  Lesson,
  LessonType,
  PersonRecord,
  RelationshipStage,
} from './memory/types.js';
export { HeartbeatLoop, shouldSuppressOutreach } from './proactive/heartbeat.js';
export { EventScheduler } from './proactive/scheduler.js';
export type { EventKind, ProactiveConfig, ProactiveEvent } from './proactive/types.js';
export { createToolRegistry, getToolsForTier } from './tools/registry.js';
export type { LoadedSkill } from './tools/skill-loader.js';
export { loadSkillsFromDirectory } from './tools/skill-loader.js';
export type { ToolRegistry, ToolTier } from './tools/types.js';
export type {
  ChatId,
  EpisodeId,
  FactId,
  GroupId,
  LessonId,
  MessageId,
  PersonId,
  UserId,
} from './types/ids.js';
export {
  asChatId,
  asEpisodeId,
  asFactId,
  asGroupId,
  asLessonId,
  asMessageId,
  asPersonId,
  asUserId,
} from './types/ids.js';
