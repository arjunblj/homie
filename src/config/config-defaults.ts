import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { OpenhomieConfig } from './types.js';

const isPathWithin = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || rel === '.' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const realpathBestEffort = async (target: string): Promise<string> => {
  return await realpath(target).catch((_err) => path.resolve(target));
};

const nearestExistingAncestor = async (target: string): Promise<string> => {
  let cursor = path.resolve(target);
  for (;;) {
    const exists = await lstat(cursor)
      .then(() => true)
      .catch((_err) => false);
    if (exists) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
};

export const resolveDir = async (
  projectDir: string,
  maybeRelative: string,
  label: string,
): Promise<string> => {
  const resolved = path.isAbsolute(maybeRelative)
    ? path.normalize(maybeRelative)
    : path.resolve(projectDir, maybeRelative);

  const projectRoot = path.resolve(projectDir);
  if (!isPathWithin(projectRoot, resolved)) {
    throw new Error(`paths.${label} must be within the project directory (${projectRoot})`);
  }
  const projectRootReal = await realpathBestEffort(projectRoot);
  const ancestor = await nearestExistingAncestor(resolved);
  const ancestorReal = await realpathBestEffort(ancestor);
  if (!isPathWithin(projectRootReal, ancestorReal)) {
    throw new Error(`paths.${label} must resolve within the project directory (${projectRoot})`);
  }
  return resolved;
};

const assertFiniteNumber = (label: string, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
};

const assertIntInRange = (label: string, value: number, min: number, max: number): void => {
  assertFiniteNumber(label, value);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
};

const assertNumInRange = (label: string, value: number, min: number, max: number): void => {
  assertFiniteNumber(label, value);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
};

export const assertConfigNumericBounds = (config: OpenhomieConfig): void => {
  assertIntInRange('engine.limiter.capacity', config.engine.limiter.capacity, 1, 1000);
  assertNumInRange('engine.limiter.refillPerSecond', config.engine.limiter.refillPerSecond, 0, 100);
  assertIntInRange(
    'engine.perChatLimiter.capacity',
    config.engine.perChatLimiter.capacity,
    1,
    1000,
  );
  assertNumInRange(
    'engine.perChatLimiter.refillPerSecond',
    config.engine.perChatLimiter.refillPerSecond,
    0,
    100,
  );
  assertIntInRange(
    'engine.perChatLimiter.staleAfterMs',
    config.engine.perChatLimiter.staleAfterMs,
    1,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange(
    'engine.perChatLimiter.sweepInterval',
    config.engine.perChatLimiter.sweepInterval,
    1,
    10_000,
  );
  assertIntInRange('engine.session.fetchLimit', config.engine.session.fetchLimit, 1, 2000);
  assertIntInRange(
    'engine.context.maxTokensDefault',
    config.engine.context.maxTokensDefault,
    256,
    200_000,
  );
  assertIntInRange(
    'engine.context.identityPromptMaxTokens',
    config.engine.context.identityPromptMaxTokens,
    64,
    200_000,
  );
  assertIntInRange(
    'engine.context.promptSkillsMaxTokens',
    config.engine.context.promptSkillsMaxTokens,
    64,
    200_000,
  );
  assertIntInRange(
    'engine.generation.reactiveMaxSteps',
    config.engine.generation.reactiveMaxSteps,
    1,
    200,
  );
  assertIntInRange(
    'engine.generation.proactiveMaxSteps',
    config.engine.generation.proactiveMaxSteps,
    1,
    200,
  );
  assertIntInRange('engine.generation.maxRegens', config.engine.generation.maxRegens, 0, 10);

  assertIntInRange('behavior.groupMaxChars', config.behavior.groupMaxChars, 50, 1000);
  assertIntInRange('behavior.dmMaxChars', config.behavior.dmMaxChars, 50, 2000);
  assertIntInRange('behavior.minDelayMs', config.behavior.minDelayMs, 0, 600_000);
  assertIntInRange('behavior.maxDelayMs', config.behavior.maxDelayMs, 0, 600_000);
  assertIntInRange('behavior.debounceMs', config.behavior.debounceMs, 0, 600_000);

  assertIntInRange(
    'proactive.heartbeatIntervalMs',
    config.proactive.heartbeatIntervalMs,
    1,
    86_400_000,
  );
  assertIntInRange('proactive.dm.maxPerDay', config.proactive.dm.maxPerDay, 0, 20);
  assertIntInRange('proactive.dm.maxPerWeek', config.proactive.dm.maxPerWeek, 0, 100);
  assertIntInRange(
    'proactive.dm.cooldownAfterUserMs',
    config.proactive.dm.cooldownAfterUserMs,
    0,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange('proactive.dm.pauseAfterIgnored', config.proactive.dm.pauseAfterIgnored, 0, 100);
  assertIntInRange('proactive.group.maxPerDay', config.proactive.group.maxPerDay, 0, 20);
  assertIntInRange('proactive.group.maxPerWeek', config.proactive.group.maxPerWeek, 0, 100);
  assertIntInRange(
    'proactive.group.cooldownAfterUserMs',
    config.proactive.group.cooldownAfterUserMs,
    0,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange(
    'proactive.group.pauseAfterIgnored',
    config.proactive.group.pauseAfterIgnored,
    0,
    100,
  );

  assertIntInRange('memory.contextBudgetTokens', config.memory.contextBudgetTokens, 1, 50_000);
  assertIntInRange('memory.capsule.maxTokens', config.memory.capsule.maxTokens, 1, 10_000);
  assertNumInRange('memory.decay.halfLifeDays', config.memory.decay.halfLifeDays, 0.1, 3650);
  assertIntInRange('memory.retrieval.rrfK', config.memory.retrieval.rrfK, 1, 500);
  assertNumInRange('memory.retrieval.ftsWeight', config.memory.retrieval.ftsWeight, 0, 10);
  assertNumInRange('memory.retrieval.vecWeight', config.memory.retrieval.vecWeight, 0, 10);
  assertNumInRange('memory.retrieval.recencyWeight', config.memory.retrieval.recencyWeight, 0, 10);
  assertIntInRange(
    'memory.feedback.finalizeAfterMs',
    config.memory.feedback.finalizeAfterMs,
    1,
    30 * 24 * 60 * 60_000,
  );
  assertNumInRange(
    'memory.feedback.successThreshold',
    config.memory.feedback.successThreshold,
    0,
    1,
  );
  assertNumInRange(
    'memory.feedback.failureThreshold',
    config.memory.feedback.failureThreshold,
    -1,
    0,
  );
  assertIntInRange(
    'memory.consolidation.intervalMs',
    config.memory.consolidation.intervalMs,
    1,
    30 * 24 * 60 * 60_000,
  );
  assertIntInRange(
    'memory.consolidation.maxEpisodesPerRun',
    config.memory.consolidation.maxEpisodesPerRun,
    1,
    1000,
  );
  assertIntInRange(
    'memory.consolidation.dirtyGroupLimit',
    config.memory.consolidation.dirtyGroupLimit,
    0,
    1000,
  );
  assertIntInRange(
    'memory.consolidation.dirtyPublicStyleLimit',
    config.memory.consolidation.dirtyPublicStyleLimit,
    0,
    1000,
  );
  assertIntInRange(
    'memory.consolidation.dirtyPersonLimit',
    config.memory.consolidation.dirtyPersonLimit,
    0,
    1000,
  );
};

const HH_MM_RE = /^\d{2}:\d{2}$/u;

export const assertHhMm = (label: string, value: string): void => {
  if (!HH_MM_RE.test(value)) {
    throw new Error(`${label} must be in HH:MM format (got "${value}")`);
  }
  const [h = NaN, m = NaN] = value.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`${label} has invalid hours/minutes (got "${value}")`);
  }
};
