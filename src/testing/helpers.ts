import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { OpenhomieConfig } from '../config/types.js';
import { MessageAccumulator, ZERO_DEBOUNCE_CONFIG } from '../engine/accumulator.js';
import type { MemoryStore } from '../memory/store.js';
import type { PersonRecord } from '../memory/types.js';

export function createNoDebounceAccumulator(): MessageAccumulator {
  return new MessageAccumulator(ZERO_DEBOUNCE_CONFIG);
}

export async function createTestIdentity(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'SOUL.md'), 'soul', 'utf8');
  await writeFile(path.join(dir, 'STYLE.md'), 'style', 'utf8');
  await writeFile(path.join(dir, 'USER.md'), 'user', 'utf8');
  await writeFile(path.join(dir, 'first-meeting.md'), 'hi', 'utf8');
  await writeFile(
    path.join(dir, 'personality.json'),
    JSON.stringify({ traits: ['x'], voiceRules: ['y'], antiPatterns: [] }),
    'utf8',
  );
}

export function createTestConfig(opts: {
  projectDir: string;
  identityDir: string;
  dataDir: string;
  overrides?: Partial<OpenhomieConfig>;
}): OpenhomieConfig {
  const { projectDir, identityDir, dataDir, overrides } = opts;
  return {
    schemaVersion: 1,
    model: {
      provider: { kind: 'anthropic' },
      models: { default: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
    },
    engine: DEFAULT_ENGINE,
    behavior: {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    },
    proactive: {
      enabled: false,
      heartbeatIntervalMs: 1_800_000,
      dm: {
        maxPerDay: 1,
        maxPerWeek: 3,
        cooldownAfterUserMs: 7_200_000,
        pauseAfterIgnored: 2,
      },
      group: {
        maxPerDay: 1,
        maxPerWeek: 1,
        cooldownAfterUserMs: 12 * 60 * 60_000,
        pauseAfterIgnored: 1,
      },
    },
    memory: DEFAULT_MEMORY,
    tools: {
      restricted: { enabledForOperator: true, allowlist: [] },
      dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
    },
    paths: { projectDir, identityDir, skillsDir: path.join(projectDir, 'skills'), dataDir },
    ...overrides,
  };
}

export function createStubMemoryStore(
  overrides?: Partial<MemoryStore> & {
    getPersonByChannelIdResult?: PersonRecord | null;
  },
): MemoryStore {
  return {
    async trackPerson() {},
    async getPerson() {
      return null;
    },
    async getPersonByChannelId() {
      return overrides?.getPersonByChannelIdResult ?? null;
    },
    async searchPeople() {
      return [];
    },
    async listPeople() {
      return [];
    },
    async updateRelationshipScore() {},
    async setTrustTierOverride() {},
    async updatePersonCapsule() {},
    async updatePublicStyleCapsule() {},
    async updateStructuredPersonData() {},
    async getStructuredPersonData() {
      return {
        currentConcerns: [],
        goals: [],
        preferences: {},
        lastMoodSignal: null,
        curiosityQuestions: [],
      };
    },
    async getGroupCapsule() {
      return null;
    },
    async upsertGroupCapsule() {},
    async markGroupCapsuleDirty() {},
    async claimDirtyGroupCapsules() {
      return [];
    },
    async completeDirtyGroupCapsule() {},
    async markPublicStyleDirty() {},
    async claimDirtyPublicStyles() {
      return [];
    },
    async completeDirtyPublicStyle() {},
    async storeFact() {},
    async updateFact() {},
    async deleteFact() {},
    async getFacts() {
      return [];
    },
    async getFactsForPerson() {
      return [];
    },
    async searchFacts() {
      return [];
    },
    async hybridSearchFacts() {
      return [];
    },
    async touchFacts() {},
    async logEpisode() {},
    async countEpisodes() {
      return 0;
    },
    async searchEpisodes() {
      return [];
    },
    async hybridSearchEpisodes() {
      return [];
    },
    async getRecentEpisodes() {
      return [];
    },
    async getRecentGroupEpisodesForPerson() {
      return [];
    },
    async getObservationCounters() {
      return {
        avgResponseLength: 0,
        avgTheirMessageLength: 0,
        activeHoursBitmask: 0,
        conversationCount: 0,
        sampleCount: 0,
      };
    },
    async updateObservationCounters() {},
    async logLesson() {},
    async getLessons() {
      return [];
    },
    async deletePerson() {},
    async exportJson() {
      return {};
    },
    async importJson() {},
    ...overrides,
  };
}
