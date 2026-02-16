export const HOMIE_AI_VERSION: string = '0.0.0';

export type { LoadedHomieConfig } from './config/load.js';
export { loadHomieConfig } from './config/load.js';
export type { HomieConfig } from './config/types.js';

export type { ChatId, GroupId, MessageId, UserId } from './types/ids.js';
export { asChatId, asGroupId, asMessageId, asUserId } from './types/ids.js';
