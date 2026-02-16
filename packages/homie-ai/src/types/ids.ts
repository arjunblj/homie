declare const chatIdBrand: unique symbol;
declare const messageIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const groupIdBrand: unique symbol;

export type ChatId = string & { readonly [chatIdBrand]: true };
export type MessageId = string & { readonly [messageIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };
export type GroupId = string & { readonly [groupIdBrand]: true };

export const asChatId = (value: string): ChatId => value as ChatId;
export const asMessageId = (value: string): MessageId => value as MessageId;
export const asUserId = (value: string): UserId => value as UserId;
export const asGroupId = (value: string): GroupId => value as GroupId;

declare const factIdBrand: unique symbol;
declare const episodeIdBrand: unique symbol;
declare const personIdBrand: unique symbol;
declare const lessonIdBrand: unique symbol;

export type FactId = number & { readonly [factIdBrand]: true };
export type EpisodeId = number & { readonly [episodeIdBrand]: true };
export type PersonId = string & { readonly [personIdBrand]: true };
export type LessonId = number & { readonly [lessonIdBrand]: true };

export const asFactId = (value: number): FactId => value as FactId;
export const asEpisodeId = (value: number): EpisodeId => value as EpisodeId;
export const asPersonId = (value: string): PersonId => value as PersonId;
export const asLessonId = (value: number): LessonId => value as LessonId;
