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
