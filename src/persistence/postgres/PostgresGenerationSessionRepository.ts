import type { GenerationSession } from "../../application/sessions/types.js";
import type { GenerateResumeResponse } from "../../api-contracts/generation.js";
import type {
  GenerationArtifactBundleRecord,
  GenerationArtifactBundleRepository,
  PersistedGenerationSessionRepository,
} from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresGenerationSessionRepository implements PersistedGenerationSessionRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(session: GenerationSession): Promise<void> {
    await this.database.query(
      `INSERT INTO generation_sessions (
        id, user_id, jd_id, target_role, status, input, generation, result_summary, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11
      )
      ON CONFLICT (id) DO UPDATE SET
        jd_id = EXCLUDED.jd_id,
        target_role = EXCLUDED.target_role,
        status = EXCLUDED.status,
        input = EXCLUDED.input,
        generation = EXCLUDED.generation,
        result_summary = EXCLUDED.result_summary,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        session.id,
        session.userId,
        session.jdId,
        session.generation.targetRole,
        session.status,
        JSON.stringify(toInputSummary(session)),
        JSON.stringify(session.generation),
        JSON.stringify(toResultSummary(session)),
        JSON.stringify(toMetadata(session)),
        session.createdAt,
        session.updatedAt,
      ],
    );
  }

  public async getById(userId: string, id: string): Promise<GenerationSession | null> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generation_sessions WHERE user_id = $1 AND id = $2 LIMIT 1",
      [userId, id],
    );
    return result.rows[0] ? toGenerationSession(result.rows[0]) : null;
  }

  public async listByUserId(userId: string): Promise<GenerationSession[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generation_sessions WHERE user_id = $1 ORDER BY created_at ASC",
      [userId],
    );
    return result.rows.map(toGenerationSession);
  }

  public async updateStatus(userId: string, id: string, status: GenerationSession["status"]): Promise<void> {
    const session = await this.getById(userId, id);
    if (!session) {
      return;
    }

    await this.save({
      ...session,
      status,
      updatedAt: new Date().toISOString(),
    });
  }
}

export class PostgresGenerationArtifactBundleRepository implements GenerationArtifactBundleRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(bundle: GenerationArtifactBundleRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO generation_artifact_bundles (
        id, user_id, session_id, artifact_id, evidence_chain_snapshot_id,
        graph_view_snapshot_id, decision_status, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10
      )
      ON CONFLICT (id) DO UPDATE SET
        evidence_chain_snapshot_id = EXCLUDED.evidence_chain_snapshot_id,
        graph_view_snapshot_id = EXCLUDED.graph_view_snapshot_id,
        decision_status = EXCLUDED.decision_status,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        bundle.id,
        bundle.userId,
        bundle.sessionId,
        bundle.artifactId,
        bundle.evidenceChainSnapshotId ?? null,
        bundle.graphViewSnapshotId ?? null,
        bundle.decisionStatus,
        JSON.stringify(bundle.metadata),
        bundle.createdAt,
        bundle.updatedAt,
      ],
    );
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<GenerationArtifactBundleRecord[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generation_artifact_bundles WHERE user_id = $1 AND session_id = $2 ORDER BY created_at ASC",
      [userId, sessionId],
    );
    return result.rows.map(toBundle);
  }
}

function toGenerationSession(row: PgRow): GenerationSession {
  const metadata = jsonValue<Record<string, unknown>>(row, "metadata", {});
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    jdId: optionalText(row, "jd_id") ?? "",
    generation: jsonValue<GenerateResumeResponse>(row, "generation"),
    artifactDecisions: Array.isArray(metadata.artifactDecisions)
      ? metadata.artifactDecisions as GenerationSession["artifactDecisions"]
      : [],
    coverageGapDecisions: Array.isArray(metadata.coverageGapDecisions)
      ? metadata.coverageGapDecisions as GenerationSession["coverageGapDecisions"]
      : [],
    supplementalArtifactDrafts: Array.isArray(metadata.supplementalArtifactDrafts)
      ? metadata.supplementalArtifactDrafts as GenerationSession["supplementalArtifactDrafts"]
      : [],
    status: text(row, "status") as GenerationSession["status"],
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}

function toBundle(row: PgRow): GenerationArtifactBundleRecord {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    sessionId: text(row, "session_id"),
    artifactId: text(row, "artifact_id"),
    evidenceChainSnapshotId: optionalText(row, "evidence_chain_snapshot_id"),
    graphViewSnapshotId: optionalText(row, "graph_view_snapshot_id"),
    decisionStatus: text(row, "decision_status") as GenerationArtifactBundleRecord["decisionStatus"],
    metadata: jsonValue<Record<string, unknown>>(row, "metadata", {}),
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}

function toResultSummary(session: GenerationSession): Record<string, unknown> {
  return {
    artifactCount: session.generation.artifacts.length,
    evidenceChainCount: session.generation.artifacts.length,
    graphViewCount: session.generation.artifacts.length,
    coverageGapCount: session.generation.coverageGapReport.items.length,
  };
}

function toInputSummary(session: GenerationSession): Record<string, unknown> {
  return {
    jdId: session.jdId,
    targetRole: session.generation.targetRole,
    artifactCount: session.generation.artifacts.length,
    createdFrom: "GenerationPersistenceService",
  };
}

function toMetadata(session: GenerationSession): Record<string, unknown> {
  return {
    artifactDecisions: session.artifactDecisions,
    coverageGapDecisions: session.coverageGapDecisions,
    supplementalArtifactDrafts: session.supplementalArtifactDrafts,
  };
}
