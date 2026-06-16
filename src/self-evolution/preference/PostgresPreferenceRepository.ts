import type { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import {
  jsonValue,
  numberValue,
  optionalText,
  text,
  timestamp,
  type PgRow,
} from "../../persistence/postgres/rowUtils.js";
import type {
  PreferenceEventRecord,
  PreferenceStatus,
  UserPreference,
} from "./types.js";
import type { PreferenceListOptions, PreferenceRepository } from "./PreferenceRepository.js";

type Db = Pick<PostgresDatabase, "query">;

export class PostgresPreferenceRepository implements PreferenceRepository {
  public constructor(private readonly database: Db) {}

  public async saveEvent(event: PreferenceEventRecord): Promise<{ event: PreferenceEventRecord; inserted: boolean }> {
    const result = await this.database.query<PgRow>(
      `INSERT INTO product_preference_event (
        id,dedupe_key,user_id,event_type,session_id,turn_id,source,payload_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
      ON CONFLICT DO NOTHING
      RETURNING *`,
      [
        event.id,
        event.dedupeKey ?? null,
        event.userId,
        event.type,
        event.sessionId ?? null,
        event.turnId ?? null,
        event.source ?? null,
        JSON.stringify(event.payload),
        event.createdAt,
      ],
    );
    if (result.rows[0]) return { event: toEvent(result.rows[0]), inserted: true };

    const existing = event.dedupeKey
      ? await this.database.query<PgRow>(
          `SELECT * FROM product_preference_event WHERE user_id = $1 AND dedupe_key = $2 LIMIT 1`,
          [event.userId, event.dedupeKey],
        )
      : await this.database.query<PgRow>(
          `SELECT * FROM product_preference_event WHERE id = $1 LIMIT 1`,
          [event.id],
        );
    return { event: existing.rows[0] ? toEvent(existing.rows[0]) : event, inserted: false };
  }

  public async getPreferenceByIdentity(userId: string, identityKey: string): Promise<UserPreference | null> {
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_user_preference WHERE user_id = $1 AND identity_key = $2 LIMIT 1`,
      [userId, identityKey],
    );
    return result.rows[0] ? toPreference(result.rows[0]) : null;
  }

  public async upsertPreference(preference: UserPreference): Promise<UserPreference> {
    const result = await this.database.query<PgRow>(
      `INSERT INTO product_user_preference (
        id,user_id,identity_key,dimension,value,instruction,scope_json,experience_id,
        strength,confidence,support_count,contradiction_count,status,source_types_json,
        evidence_event_ids_json,first_observed_at,last_observed_at,last_used_at,metadata_json,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19::jsonb,$20)
      ON CONFLICT (user_id, identity_key) DO UPDATE SET
        instruction=EXCLUDED.instruction,
        scope_json=EXCLUDED.scope_json,
        experience_id=EXCLUDED.experience_id,
        strength=EXCLUDED.strength,
        confidence=EXCLUDED.confidence,
        support_count=EXCLUDED.support_count,
        contradiction_count=EXCLUDED.contradiction_count,
        status=EXCLUDED.status,
        source_types_json=EXCLUDED.source_types_json,
        evidence_event_ids_json=EXCLUDED.evidence_event_ids_json,
        last_observed_at=EXCLUDED.last_observed_at,
        last_used_at=COALESCE(EXCLUDED.last_used_at, product_user_preference.last_used_at),
        metadata_json=EXCLUDED.metadata_json,
        updated_at=EXCLUDED.updated_at
      RETURNING *`,
      [
        preference.id,
        preference.userId,
        preference.identityKey,
        preference.dimension,
        preference.value,
        preference.instruction,
        JSON.stringify(preference.scope),
        preference.experienceId ?? null,
        preference.strength,
        preference.confidence,
        preference.supportCount,
        preference.contradictionCount,
        preference.status,
        JSON.stringify(preference.sourceTypes),
        JSON.stringify(preference.evidenceEventIds),
        preference.firstObservedAt,
        preference.lastObservedAt,
        preference.lastUsedAt ?? null,
        JSON.stringify(preference.metadata),
        preference.updatedAt,
      ],
    );
    return result.rows[0] ? toPreference(result.rows[0]) : preference;
  }

  public async listPreferences(userId: string, options: PreferenceListOptions = {}): Promise<UserPreference[]> {
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_user_preference
       WHERE user_id = $1
         AND ($2::text[] IS NULL OR status = ANY($2))
       ORDER BY updated_at DESC
       LIMIT $3`,
      [userId, options.statuses && options.statuses.length > 0 ? options.statuses : null, options.limit ?? 500],
    );
    return result.rows.map(toPreference);
  }

  public async touchPreferences(userId: string, preferenceIds: string[], usedAt: string): Promise<number> {
    if (preferenceIds.length === 0) return 0;
    const result = await this.database.query(
      `UPDATE product_user_preference
       SET last_used_at = $3, updated_at = $3
       WHERE user_id = $1 AND id = ANY($2::text[])`,
      [userId, preferenceIds, usedAt],
    );
    return result.rowCount;
  }
}

function toEvent(row: PgRow): PreferenceEventRecord {
  return {
    id: text(row, "id"),
    dedupeKey: optionalText(row, "dedupe_key"),
    userId: text(row, "user_id"),
    type: text(row, "event_type"),
    sessionId: optionalText(row, "session_id"),
    turnId: optionalText(row, "turn_id"),
    source: optionalText(row, "source"),
    payload: jsonValue<Record<string, unknown>>(row, "payload_json", {}),
    createdAt: timestamp(row, "created_at"),
  };
}

function toPreference(row: PgRow): UserPreference {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    identityKey: text(row, "identity_key"),
    dimension: text(row, "dimension") as UserPreference["dimension"],
    value: text(row, "value"),
    instruction: text(row, "instruction"),
    scope: jsonValue<UserPreference["scope"]>(row, "scope_json", {}),
    experienceId: optionalText(row, "experience_id"),
    strength: numberValue(row, "strength"),
    confidence: numberValue(row, "confidence"),
    supportCount: numberValue(row, "support_count"),
    contradictionCount: numberValue(row, "contradiction_count"),
    status: text(row, "status") as PreferenceStatus,
    sourceTypes: jsonValue<string[]>(row, "source_types_json", []),
    evidenceEventIds: jsonValue<string[]>(row, "evidence_event_ids_json", []),
    firstObservedAt: timestamp(row, "first_observed_at"),
    lastObservedAt: timestamp(row, "last_observed_at"),
    lastUsedAt: optionalText(row, "last_used_at"),
    metadata: jsonValue<Record<string, unknown>>(row, "metadata_json", {}),
    updatedAt: timestamp(row, "updated_at"),
  };
}
