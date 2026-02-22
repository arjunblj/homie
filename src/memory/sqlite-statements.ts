import type { Database } from 'bun:sqlite';

type SqliteStatement = ReturnType<Database['query']>;

export type MemoryStatements = Readonly<{
  upsertPerson: SqliteStatement;
  selectPersonById: SqliteStatement;
  selectPersonByChannelUserId: SqliteStatement;
  searchPeopleLike: SqliteStatement;
  listPeoplePaged: SqliteStatement;
  updateRelationshipScore: SqliteStatement;
  updateTrustTierOverride: SqliteStatement;
  updatePersonCapsule: SqliteStatement;
  updatePublicStyleCapsule: SqliteStatement;

  selectStructuredPersonData: SqliteStatement;
  updateStructuredPersonData: SqliteStatement;

  selectGroupCapsule: SqliteStatement;
  upsertGroupCapsule: SqliteStatement;

  updateFactContent: SqliteStatement;
  updateFactFtsContent: SqliteStatement;
  setFactIsCurrent: SqliteStatement;
  deleteFactFts: SqliteStatement;
  deleteFact: SqliteStatement;
  insertFact: SqliteStatement;
  insertFactFts: SqliteStatement;
  selectFactsBySubject: SqliteStatement;
  selectFactsByPerson: SqliteStatement;
  searchFactsFts: SqliteStatement;

  insertEpisode: SqliteStatement;
  insertEpisodeFts: SqliteStatement;
  countEpisodesByChatId: SqliteStatement;
  searchEpisodesFts: SqliteStatement;
  selectRecentEpisodes: SqliteStatement;
  selectRecentGroupEpisodesForPerson: SqliteStatement;
  selectRecentDmEpisodesForPerson: SqliteStatement;
  selectEpisodesNeedingExtraction: SqliteStatement;
  markEpisodeExtracted: SqliteStatement;

  upsertGroupCapsuleDirty: SqliteStatement;
  claimDirtyGroupCapsulesAtomic: SqliteStatement;
  deleteGroupCapsuleDirtyIfClean: SqliteStatement;
  releaseGroupCapsuleDirtyClaim: SqliteStatement;

  upsertPublicStyleDirty: SqliteStatement;
  claimDirtyPublicStylesAtomic: SqliteStatement;
  deletePublicStyleDirtyIfClean: SqliteStatement;
  releasePublicStyleDirtyClaim: SqliteStatement;

  insertLesson: SqliteStatement;
  selectLessonsByCategory: SqliteStatement;
  selectLessonsAll: SqliteStatement;
  setLessonPromoted: SqliteStatement;

  selectObservationCounters: SqliteStatement;
  upsertObservationCounters: SqliteStatement;

  selectFactIdsByPerson: SqliteStatement;
  selectEpisodeIdsByPerson: SqliteStatement;
  deleteFactsByPerson: SqliteStatement;
  deleteEpisodesByPerson: SqliteStatement;
  deleteLessonsByPerson: SqliteStatement;
  deletePublicStyleDirtyByPerson: SqliteStatement;
  deletePerson: SqliteStatement;

  countPeople: SqliteStatement;
  countFacts: SqliteStatement;
  countEpisodes: SqliteStatement;
  countLessons: SqliteStatement;

  exportPeople: SqliteStatement;
  exportFacts: SqliteStatement;
  exportEpisodes: SqliteStatement;
  exportGroupCapsules: SqliteStatement;
  exportLessons: SqliteStatement;

  importPersonReplace: SqliteStatement;
  importFact: SqliteStatement;
  importFactFts: SqliteStatement;
  importEpisode: SqliteStatement;
  importEpisodeFts: SqliteStatement;
  importLesson: SqliteStatement;
}>;

export function createStatements(db: Database): MemoryStatements {
  return {
    upsertPerson: db.query(
      `INSERT INTO people (
         id,
         display_name,
         channel,
         channel_user_id,
         relationship_stage,
         relationship_score,
         trust_tier_override,
         capsule,
         capsule_updated_at_ms,
         public_style_capsule,
         created_at_ms,
         updated_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, channel_user_id) DO UPDATE SET
         display_name=excluded.display_name,
         relationship_score=max(relationship_score, excluded.relationship_score),
         trust_tier_override=coalesce(excluded.trust_tier_override, trust_tier_override),
         capsule=coalesce(excluded.capsule, capsule),
         capsule_updated_at_ms=coalesce(excluded.capsule_updated_at_ms, capsule_updated_at_ms),
         public_style_capsule=coalesce(excluded.public_style_capsule, public_style_capsule),
         updated_at_ms=excluded.updated_at_ms`,
    ),
    selectPersonById: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, capsule_updated_at_ms, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people WHERE id = ?`,
    ),
    selectPersonByChannelUserId: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, capsule_updated_at_ms, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people WHERE channel_user_id = ? LIMIT 1`,
    ),
    searchPeopleLike: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, capsule_updated_at_ms, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people
       WHERE display_name LIKE ? OR channel_user_id LIKE ?
       ORDER BY updated_at_ms DESC
       LIMIT 25`,
    ),
    listPeoplePaged: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, capsule_updated_at_ms, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people
       ORDER BY updated_at_ms DESC
       LIMIT ? OFFSET ?`,
    ),
    updateRelationshipScore: db.query(
      `UPDATE people SET relationship_score = max(relationship_score, ?), updated_at_ms = ? WHERE id = ?`,
    ),
    updateTrustTierOverride: db.query(
      `UPDATE people SET trust_tier_override = ?, updated_at_ms = ? WHERE id = ?`,
    ),
    updatePersonCapsule: db.query(
      `UPDATE people SET capsule = ?, capsule_updated_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
    ),
    updatePublicStyleCapsule: db.query(
      `UPDATE people SET public_style_capsule = ?, updated_at_ms = ? WHERE id = ?`,
    ),

    selectStructuredPersonData: db.query(
      `SELECT current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json
       FROM people WHERE id = ?`,
    ),
    updateStructuredPersonData: db.query(
      `UPDATE people SET
         current_concerns_json = ?,
         goals_json = ?,
         preferences_json = ?,
         last_mood_signal = ?,
         curiosity_questions_json = ?,
         updated_at_ms = ?
       WHERE id = ?`,
    ),

    selectGroupCapsule: db.query(`SELECT capsule FROM group_capsules WHERE chat_id = ? LIMIT 1`),
    upsertGroupCapsule: db.query(
      `INSERT INTO group_capsules (chat_id, capsule, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         capsule=excluded.capsule,
         updated_at_ms=excluded.updated_at_ms`,
    ),

    updateFactContent: db.query('UPDATE facts SET content = ? WHERE id = ?'),
    updateFactFtsContent: db.query('UPDATE facts_fts SET content = ? WHERE fact_id = ?'),
    setFactIsCurrent: db.query('UPDATE facts SET is_current = ? WHERE id = ?'),
    deleteFactFts: db.query('DELETE FROM facts_fts WHERE fact_id = ?'),
    deleteFact: db.query('DELETE FROM facts WHERE id = ?'),
    insertFact: db.query(
      `INSERT INTO facts (
         person_id,
         subject,
         content,
         category,
         fact_type,
         temporal_scope,
         evidence_quote,
         confidence_tier,
         is_current,
         last_accessed_at_ms,
         created_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertFactFts: db.query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`),
    selectFactsBySubject: db.query(
      `SELECT id, person_id, subject, content, category, fact_type, temporal_scope, evidence_quote,
              confidence_tier, is_current, last_accessed_at_ms, created_at_ms
       FROM facts
       WHERE subject = ? AND is_current = 1
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),
    selectFactsByPerson: db.query(
      `SELECT id, person_id, subject, content, category, fact_type, temporal_scope, evidence_quote,
              confidence_tier, is_current, last_accessed_at_ms, created_at_ms
       FROM facts
       WHERE person_id = ? AND is_current = 1
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),
    searchFactsFts: db.query(
      `SELECT f.id, f.person_id, f.subject, f.content, f.category, f.fact_type, f.temporal_scope,
              f.evidence_quote, f.confidence_tier, f.is_current, f.last_accessed_at_ms, f.created_at_ms
       FROM facts_fts
       JOIN facts f ON f.id = facts_fts.fact_id
       WHERE facts_fts MATCH ? AND f.is_current = 1
       ORDER BY rank
       LIMIT ?`,
    ),

    insertEpisode: db.query(
      `INSERT INTO episodes (chat_id, person_id, is_group, content, created_at_ms) VALUES (?, ?, ?, ?, ?)`,
    ),
    insertEpisodeFts: db.query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`),
    countEpisodesByChatId: db.query(`SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?`),
    searchEpisodesFts: db.query(
      `SELECT e.id, e.chat_id, e.content, e.created_at_ms
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.episode_id
       WHERE episodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ),
    selectRecentEpisodes: db.query(
      `SELECT id, chat_id, person_id, is_group, content, created_at_ms
       FROM episodes
       WHERE chat_id = ? AND created_at_ms >= ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),

    selectRecentGroupEpisodesForPerson: db.query(
      `SELECT id, chat_id, person_id, is_group, content, created_at_ms
       FROM episodes
       WHERE person_id = ? AND is_group = 1 AND created_at_ms >= ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),
    selectRecentDmEpisodesForPerson: db.query(
      `SELECT id, chat_id, person_id, is_group, content, created_at_ms
       FROM episodes
       WHERE person_id = ? AND COALESCE(is_group, 0) = 0 AND created_at_ms >= ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),
    selectEpisodesNeedingExtraction: db.query(
      `SELECT id, chat_id, person_id, is_group, content, created_at_ms, last_extracted_at_ms
       FROM episodes
       WHERE last_extracted_at_ms IS NULL OR last_extracted_at_ms < created_at_ms
       ORDER BY created_at_ms ASC
       LIMIT ?`,
    ),
    markEpisodeExtracted: db.query(`UPDATE episodes SET last_extracted_at_ms = ? WHERE id = ?`),

    upsertGroupCapsuleDirty: db.query(
      `INSERT INTO group_capsule_dirty (chat_id, dirty_at_ms, dirty_last_at_ms, claimed_at_ms)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(chat_id) DO UPDATE SET
         dirty_at_ms = MIN(group_capsule_dirty.dirty_at_ms, excluded.dirty_at_ms),
         dirty_last_at_ms = MAX(COALESCE(group_capsule_dirty.dirty_last_at_ms, group_capsule_dirty.dirty_at_ms), excluded.dirty_last_at_ms)`,
    ),
    claimDirtyGroupCapsulesAtomic: db.query(
      `UPDATE group_capsule_dirty
       SET claimed_at_ms = ?
       WHERE chat_id IN (
         SELECT chat_id
         FROM group_capsule_dirty
         WHERE claimed_at_ms IS NULL OR claimed_at_ms < ?
         ORDER BY dirty_at_ms ASC
         LIMIT ?
       )
       AND (claimed_at_ms IS NULL OR claimed_at_ms < ?)
       RETURNING chat_id`,
    ),
    deleteGroupCapsuleDirtyIfClean: db.query(
      `DELETE FROM group_capsule_dirty
       WHERE chat_id = ?
         AND COALESCE(dirty_last_at_ms, dirty_at_ms) <= claimed_at_ms`,
    ),
    releaseGroupCapsuleDirtyClaim: db.query(
      `UPDATE group_capsule_dirty
       SET claimed_at_ms = NULL
       WHERE chat_id = ?`,
    ),

    upsertPublicStyleDirty: db.query(
      `INSERT INTO public_style_dirty (person_id, dirty_at_ms, dirty_last_at_ms, claimed_at_ms)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(person_id) DO UPDATE SET
         dirty_at_ms = MIN(public_style_dirty.dirty_at_ms, excluded.dirty_at_ms),
         dirty_last_at_ms = MAX(COALESCE(public_style_dirty.dirty_last_at_ms, public_style_dirty.dirty_at_ms), excluded.dirty_last_at_ms)`,
    ),
    claimDirtyPublicStylesAtomic: db.query(
      `UPDATE public_style_dirty
       SET claimed_at_ms = ?
       WHERE person_id IN (
         SELECT person_id
         FROM public_style_dirty
         WHERE claimed_at_ms IS NULL OR claimed_at_ms < ?
         ORDER BY dirty_at_ms ASC
         LIMIT ?
       )
       AND (claimed_at_ms IS NULL OR claimed_at_ms < ?)
       RETURNING person_id`,
    ),
    deletePublicStyleDirtyIfClean: db.query(
      `DELETE FROM public_style_dirty
       WHERE person_id = ?
         AND COALESCE(dirty_last_at_ms, dirty_at_ms) <= claimed_at_ms`,
    ),
    releasePublicStyleDirtyClaim: db.query(
      `UPDATE public_style_dirty
       SET claimed_at_ms = NULL
       WHERE person_id = ?`,
    ),

    insertLesson: db.query(
      `INSERT INTO lessons (
         type, category, content, rule, alternative, person_id, episode_refs, confidence,
         times_validated, times_violated, promoted, created_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectLessonsByCategory: db.query(
      `SELECT id, type, category, content, rule, alternative, person_id, episode_refs, confidence,
              times_validated, times_violated, promoted, created_at_ms
       FROM lessons
       WHERE category = ?
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),
    selectLessonsAll: db.query(
      `SELECT id, type, category, content, rule, alternative, person_id, episode_refs, confidence,
              times_validated, times_violated, promoted, created_at_ms
       FROM lessons
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),
    setLessonPromoted: db.query(`UPDATE lessons SET promoted = ? WHERE id = ?`),

    selectObservationCounters: db.query(
      `SELECT avg_response_length, avg_their_message_length, active_hours_bitmask, conversation_count, sample_count
       FROM observation_counters WHERE person_id = ?`,
    ),
    upsertObservationCounters: db.query(
      `INSERT INTO observation_counters (person_id, avg_response_length, avg_their_message_length, active_hours_bitmask, conversation_count, sample_count, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(person_id) DO UPDATE SET
         avg_response_length = excluded.avg_response_length,
         avg_their_message_length = excluded.avg_their_message_length,
         active_hours_bitmask = excluded.active_hours_bitmask,
         conversation_count = excluded.conversation_count,
         sample_count = excluded.sample_count,
         updated_at_ms = excluded.updated_at_ms`,
    ),

    selectFactIdsByPerson: db.query(`SELECT id FROM facts WHERE person_id = ?`),
    selectEpisodeIdsByPerson: db.query(`SELECT id FROM episodes WHERE person_id = ?`),
    deleteFactsByPerson: db.query(`DELETE FROM facts WHERE person_id = ?`),
    deleteEpisodesByPerson: db.query(`DELETE FROM episodes WHERE person_id = ?`),
    deleteLessonsByPerson: db.query(`DELETE FROM lessons WHERE person_id = ?`),
    deletePublicStyleDirtyByPerson: db.query(`DELETE FROM public_style_dirty WHERE person_id = ?`),
    deletePerson: db.query(`DELETE FROM people WHERE id = ?`),

    countPeople: db.query(`SELECT COUNT(*) as c FROM people`),
    countFacts: db.query(`SELECT COUNT(*) as c FROM facts`),
    countEpisodes: db.query(`SELECT COUNT(*) as c FROM episodes`),
    countLessons: db.query(`SELECT COUNT(*) as c FROM lessons`),

    exportPeople: db.query(`SELECT * FROM people`),
    exportFacts: db.query(`SELECT * FROM facts`),
    exportEpisodes: db.query(`SELECT * FROM episodes`),
    exportGroupCapsules: db.query(`SELECT * FROM group_capsules`),
    exportLessons: db.query(`SELECT * FROM lessons`),

    importPersonReplace: db.query(
      `INSERT OR REPLACE INTO people (
         id,
         display_name,
         channel,
         channel_user_id,
         relationship_stage,
         relationship_score,
         trust_tier_override,
         capsule,
         capsule_updated_at_ms,
         public_style_capsule,
         created_at_ms,
         updated_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    importFact: db.query(
      `INSERT INTO facts (
         person_id,
         subject,
         content,
         category,
         fact_type,
         temporal_scope,
         evidence_quote,
         confidence_tier,
         is_current,
         last_accessed_at_ms,
         created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    importFactFts: db.query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`),
    importEpisode: db.query(
      `INSERT INTO episodes (
         chat_id, person_id, is_group, content, last_extracted_at_ms, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    importEpisodeFts: db.query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`),
    importLesson: db.query(
      `INSERT INTO lessons (
         type, category, content, rule, alternative, person_id, episode_refs, confidence,
         times_validated, times_violated, promoted, created_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  };
}
