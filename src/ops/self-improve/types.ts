export type SelfImproveItemStatus = 'pending' | 'in_progress' | 'completed' | 'deferred';

export type SelfImproveClassification = 'thorn' | 'bud';

export type SelfImproveScope =
  | 'engine'
  | 'tools'
  | 'memory'
  | 'security'
  | 'proactive'
  | 'channels'
  | 'backend'
  | 'cli'
  | 'identity'
  | 'repo'
  | 'unknown';

export type SelfImproveSourceLesson = {
  lessonId: number;
  lessonType?: string | undefined;
  confidence?: number | undefined;
  createdAtMs?: number | undefined;
  preview: string;
};

export interface SelfImproveItemDraft {
  classification: SelfImproveClassification;
  scope: SelfImproveScope;
  confidence: number;
  title: string;
  why: string;
  proposal: string;
  /** Optional hints for the runner (best-effort). */
  filesHint?: string[] | undefined;
  searchTerms?: string[] | undefined;
  sourceLessons: SelfImproveSourceLesson[];
}

export interface SelfImproveItem extends SelfImproveItemDraft {
  id: number;
  status: SelfImproveItemStatus;
  dedupeKey: string;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number | undefined;
  completedAtMs?: number | undefined;
  deferredAtMs?: number | undefined;
  deferredReason?: string | undefined;
  prUrl?: string | undefined;
  claimId?: string | undefined;
  claimUntilMs?: number | undefined;
}

export interface SelfImprovePlanResult {
  readonly planned: readonly SelfImproveItemDraft[];
  readonly skippedBecauseNoLessons: boolean;
}
