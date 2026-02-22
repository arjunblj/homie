import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type { EngagementDecision } from '../behavior/engine.js';
import { userRequestedVoiceNote } from '../behavior/voiceHint.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import { updateCounters } from '../memory/observations.js';
import type { MemoryStore } from '../memory/store.js';
import { scoreFromSignals } from '../memory/types.js';
import type { ProactiveEvent } from '../proactive/types.js';
import type { SessionStore } from '../session/types.js';
import { asPersonId } from '../types/ids.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { OutgoingAction } from './types.js';

export interface PersistenceDeps {
  sessionStore: SessionStore | undefined;
  memoryStore: MemoryStore | undefined;
  extractor: MemoryExtractor | undefined;
  logger: Logger;
  trackBackground: (<T>(promise: Promise<T>) => Promise<T>) | undefined;
}

function trackBackgroundBestEffort<T>(
  deps: PersistenceDeps,
  promise: Promise<T>,
  task: string,
): void {
  const tracker = deps.trackBackground;
  if (!tracker) {
    void promise;
    return;
  }

  try {
    void tracker(promise).catch((err) => {
      deps.logger.debug('background.track_failed', { task, ...errorFields(err) });
    });
  } catch (err) {
    deps.logger.debug('background.track_threw', { task, ...errorFields(err) });
    void promise;
  }
}

function updateObservationsBestEffort(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  responseText: string,
): void {
  const { memoryStore } = deps;
  if (!memoryStore || msg.isGroup) return;

  const pid = asPersonId(`person:${channelUserId(msg)}`);
  const hourOfDay = new Date().getHours();

  const p = (async () => {
    const current = await memoryStore.getObservationCounters(pid);
    const updated = updateCounters(current, {
      responseLength: responseText.length,
      theirMessageLength: msg.text.length,
      hourOfDay,
      isNewConversation: current.sampleCount === 0,
    });
    await memoryStore.updateObservationCounters(pid, updated);
  })().catch((err) => {
    deps.logger.debug('memory.observations_update_failed', errorFields(err));
  });

  trackBackgroundBestEffort(deps, p, 'observations_update');
}

function runExtractionBestEffort(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  userText: string,
  assistantText?: string,
): void {
  const { memoryStore, extractor } = deps;
  if (!memoryStore || !extractor) return;
  if (msg.isGroup && assistantText === undefined) return;

  const p = extractor
    .extractAndReconcile({
      msg,
      userText,
      ...(assistantText !== undefined ? { assistantText } : {}),
    })
    .catch((err: unknown) => {
      deps.logger.debug('memory.extractor_failed', errorFields(err));
    });

  trackBackgroundBestEffort(deps, p, 'extract_and_reconcile');
}

async function maybeUpdateRelationshipScore(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  nowMs: number,
): Promise<void> {
  const memoryStore = deps.memoryStore;
  if (!memoryStore || msg.isGroup) return;
  try {
    const person = await memoryStore.getPersonByChannelId(channelUserId(msg));
    if (!person) return;
    const episodes = await memoryStore.countEpisodes(msg.chatId);
    const score = scoreFromSignals(episodes, nowMs - person.createdAtMs);
    if (score > (person.relationshipScore ?? 0)) {
      await memoryStore.updateRelationshipScore(person.id, score);
    }
  } catch (err) {
    deps.logger.debug('memory.relationship_score_update_failed', errorFields(err));
  }
}

export async function persistSilenceDecision(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  userText: string,
  action: Extract<EngagementDecision, { kind: 'silence' }>,
): Promise<OutgoingAction> {
  const { memoryStore } = deps;
  const nowMs = Date.now();

  if (memoryStore) {
    await memoryStore.logLesson({
      category: 'silence_decision',
      content: action.reason ?? 'silence',
      createdAtMs: nowMs,
    });
  }
  runExtractionBestEffort(deps, msg, userText);
  return { kind: 'silence', reason: action.reason ?? 'silence' };
}

export async function persistAndReturnReaction(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  userText: string,
  emoji: string,
): Promise<OutgoingAction> {
  const { sessionStore, memoryStore } = deps;
  const nowMs = Date.now();

  sessionStore?.appendMessage({
    chatId: msg.chatId,
    role: 'assistant',
    content: `[REACTION] ${emoji}`,
    createdAtMs: nowMs,
  });
  if (memoryStore) {
    const pid = asPersonId(`person:${channelUserId(msg)}`);
    await memoryStore.logEpisode({
      chatId: msg.chatId,
      personId: pid,
      isGroup: msg.isGroup,
      content: `USER: ${userText}\nFRIEND_REACTION: ${emoji}`,
      createdAtMs: nowMs,
    });
    await maybeUpdateRelationshipScore(deps, msg, nowMs);
  }
  runExtractionBestEffort(deps, msg, userText);
  return {
    kind: 'react',
    emoji,
    targetAuthorId: msg.authorId,
    targetTimestampMs: msg.timestampMs,
  };
}

export async function persistAndReturnAction(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  userText: string,
  draftText: string,
): Promise<OutgoingAction> {
  const { sessionStore, memoryStore } = deps;
  const nowMs = Date.now();

  const action: OutgoingAction = { kind: 'send_text', text: draftText };

  sessionStore?.appendMessage({
    chatId: msg.chatId,
    role: 'assistant',
    content: action.text,
    createdAtMs: nowMs,
  });
  if (memoryStore) {
    const pid = asPersonId(`person:${channelUserId(msg)}`);
    await memoryStore.logEpisode({
      chatId: msg.chatId,
      personId: pid,
      isGroup: msg.isGroup,
      content: `USER: ${userText}\nFRIEND: ${action.text}`,
      createdAtMs: nowMs,
    });
    await maybeUpdateRelationshipScore(deps, msg, nowMs);
  }
  updateObservationsBestEffort(deps, msg, action.text);
  runExtractionBestEffort(deps, msg, userText, action.text);
  const ttsHint = userRequestedVoiceNote(msg.text);
  return ttsHint ? { ...action, ttsHint } : action;
}

export async function persistAndReturnProactiveAction(
  deps: PersistenceDeps,
  msg: IncomingMessage,
  event: ProactiveEvent,
  draftText: string,
  nowMs: number,
): Promise<OutgoingAction> {
  const { sessionStore, memoryStore } = deps;

  const action: OutgoingAction = { kind: 'send_text', text: draftText };

  sessionStore?.appendMessage({
    chatId: msg.chatId,
    role: 'assistant',
    content: action.text,
    createdAtMs: nowMs,
  });
  if (memoryStore) {
    await memoryStore.logEpisode({
      chatId: msg.chatId,
      isGroup: msg.isGroup,
      content: `PROACTIVE_EVENT: ${event.kind} — ${event.subject}\nFRIEND: ${action.text}`,
      createdAtMs: nowMs,
    });
  }
  return action;
}
