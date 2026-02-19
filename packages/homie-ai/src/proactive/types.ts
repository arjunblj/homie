import type { ProactiveRateLimits } from '../config/types.js';
import type { ChatId } from '../types/ids.js';

export const EVENT_KINDS = [
  'reminder',
  'birthday',
  'follow_up',
  'check_in',
  'anticipated',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface ProactiveEvent {
  readonly id: number;
  readonly kind: EventKind;
  readonly subject: string;
  readonly chatId: ChatId;
  readonly triggerAtMs: number;
  readonly recurrence: 'once' | 'yearly' | null;
  readonly delivered: boolean;
  readonly createdAtMs: number;
}

export interface ProactiveConfig {
  readonly enabled: boolean;
  readonly heartbeatIntervalMs: number;
  readonly dm: Readonly<ProactiveRateLimits>;
  readonly group: Readonly<ProactiveRateLimits>;
}
