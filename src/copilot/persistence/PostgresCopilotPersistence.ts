import type { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "../../persistence/postgres/rowUtils.js";
import type { CopilotMessage, CopilotSession, CopilotTurn, CopilotWorkspace } from "../types.js";
import { normalizeCopilotMessage, normalizeCopilotWorkspace, normalizeCopilotTurn } from "../normalize.js";
import type {
  CopilotActivity,
  CopilotPersistence,
  ListCopilotRecordsOptions,
  ListCopilotSessionsOptions,
} from "./CopilotPersistence.js";

type Db = Pick<PostgresDatabase, "query">;

export class PostgresCopilotPersistence implements CopilotPersistence {
  public readonly sessions: PostgresCopilotSessionRepository;
  public readonly messages: PostgresCopilotMessageRepository;
  public readonly turns: PostgresCopilotTurnRepository;
  public readonly workspaces: PostgresCopilotWorkspaceRepository;
  public readonly activities: PostgresCopilotActivityRepository;

  public constructor(database: Db) {
    this.sessions = new PostgresCopilotSessionRepository(database);
    this.messages = new PostgresCopilotMessageRepository(database);
    this.turns = new PostgresCopilotTurnRepository(database);
    this.workspaces = new PostgresCopilotWorkspaceRepository(database);
    this.activities = new PostgresCopilotActivityRepository(database);
  }
}

export class PostgresCopilotSessionRepository {
  public constructor(private readonly database: Db) {}

  public async createSession(session: CopilotSession): Promise<CopilotSession> {
    await this.database.query(
      `INSERT INTO copilot_session (
        id,user_id,title,target_role,resume_text,jd_text,current_workspace_id,status,
        resume_ingested,resume_document_ids_json,resume_artifact_ids_json,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        title=EXCLUDED.title,target_role=EXCLUDED.target_role,resume_text=EXCLUDED.resume_text,
        jd_text=EXCLUDED.jd_text,current_workspace_id=EXCLUDED.current_workspace_id,status=EXCLUDED.status,
        resume_ingested=EXCLUDED.resume_ingested,resume_document_ids_json=EXCLUDED.resume_document_ids_json,
        resume_artifact_ids_json=EXCLUDED.resume_artifact_ids_json,updated_at=EXCLUDED.updated_at`,
      [
        session.id, session.userId, session.title ?? null, session.targetRole ?? null,
        session.resumeText ?? null, session.jdText ?? null, session.currentWorkspaceId ?? null,
        session.status ?? "active", session.resumeIngested, JSON.stringify(session.resumeDocumentIds ?? []),
        JSON.stringify(session.resumeArtifactIds ?? []), session.createdAt, session.updatedAt,
      ],
    );
    return session;
  }

  public async getSession(userId: string, sessionId: string): Promise<CopilotSession | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM copilot_session WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, sessionId]);
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  public async updateSession(userId: string, sessionId: string, patch: Partial<CopilotSession>): Promise<CopilotSession | null> {
    const current = await this.getSession(userId, sessionId);
    if (!current) return null;
    return this.createSession({ ...current, ...patch, id: current.id, userId: current.userId, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  }

  public async listSessions(userId: string, options: ListCopilotSessionsOptions = {}): Promise<CopilotSession[]> {
    const params: unknown[] = [userId];
    const statusClause = options.status ? "AND status = $2" : "";
    if (options.status) params.push(options.status);
    params.push(options.limit ?? 50);
    const result = await this.database.query<PgRow>(
      `SELECT * FROM copilot_session WHERE user_id = $1 ${statusClause} ORDER BY updated_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toSession);
  }

  public archiveSession(userId: string, sessionId: string): Promise<CopilotSession | null> {
    return this.updateSession(userId, sessionId, { status: "archived" });
  }
}

export class PostgresCopilotMessageRepository {
  public constructor(private readonly database: Db) {}

  public async createMessage(message: CopilotMessage & { userId: string }): Promise<CopilotMessage> {
    await this.database.query(
      `INSERT INTO copilot_message (id,session_id,user_id,turn_id,role,kind,content,metadata_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, metadata_json=EXCLUDED.metadata_json`,
      [
        message.id, message.sessionId, message.userId, message.turnId ?? null, message.role,
        message.kind, message.content, JSON.stringify(message.metadata ?? null), message.createdAt,
      ],
    );
    return message;
  }

  public async listMessages(userId: string, sessionId: string, options: ListCopilotRecordsOptions = {}): Promise<CopilotMessage[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM copilot_message WHERE user_id = $1 AND session_id = $2 ORDER BY created_at ASC LIMIT $3",
      [userId, sessionId, options.limit ?? 200],
    );
    return result.rows.map(toMessage);
  }

  public async getRecentMessages(userId: string, sessionId: string, limit: number): Promise<CopilotMessage[]> {
    const result = await this.database.query<PgRow>(
      `SELECT * FROM (
        SELECT * FROM copilot_message WHERE user_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT $3
      ) recent ORDER BY created_at ASC`,
      [userId, sessionId, limit],
    );
    return result.rows.map(toMessage);
  }
}

export class PostgresCopilotTurnRepository {
  public constructor(private readonly database: Db) {}

  public async createTurn(turn: CopilotTurn & { userId: string }): Promise<CopilotTurn> {
    await this.database.query(
      `INSERT INTO copilot_turn (id,session_id,user_id,user_message_id,assistant_message_id,intent,status,error,created_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET assistant_message_id=EXCLUDED.assistant_message_id,intent=EXCLUDED.intent,status=EXCLUDED.status,error=EXCLUDED.error,completed_at=EXCLUDED.completed_at`,
      [
        turn.id, turn.sessionId, turn.userId, turn.userMessageId, turn.assistantMessageId ?? null,
        turn.intent ?? null, turn.status, turn.error ?? null, turn.createdAt, turn.completedAt ?? null,
      ],
    );
    return turn;
  }

  public async updateTurn(userId: string, turnId: string, patch: Partial<CopilotTurn>): Promise<CopilotTurn | null> {
    const current = await this.database.query<PgRow>("SELECT * FROM copilot_turn WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, turnId]);
    if (!current.rows[0]) return null;
    const next = { ...toTurn(current.rows[0]), ...patch };
    await this.createTurn({ ...next, userId });
    return next;
  }

  public async listTurns(userId: string, sessionId: string, options: ListCopilotRecordsOptions = {}): Promise<CopilotTurn[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM copilot_turn WHERE user_id = $1 AND session_id = $2 ORDER BY created_at ASC LIMIT $3",
      [userId, sessionId, options.limit ?? 200],
    );
    return result.rows.map(toTurn);
  }
}

export class PostgresCopilotWorkspaceRepository {
  public constructor(private readonly database: Db) {}

  public async upsertWorkspace(userId: string, workspace: CopilotWorkspace): Promise<CopilotWorkspace> {
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO copilot_workspace (
        id,session_id,user_id,active_variant_id,active_panel,product_generation_id,jd_id,resume_id,
        status,summary,workspace_json,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        active_variant_id=EXCLUDED.active_variant_id,active_panel=EXCLUDED.active_panel,
        product_generation_id=EXCLUDED.product_generation_id,jd_id=EXCLUDED.jd_id,resume_id=EXCLUDED.resume_id,
        status=EXCLUDED.status,summary=EXCLUDED.summary,workspace_json=EXCLUDED.workspace_json,updated_at=EXCLUDED.updated_at`,
      [
        workspace.id, workspace.sessionId, userId, workspace.activeVariantId ?? null, workspace.activePanel ?? null,
        workspace.productGenerationId ?? null, workspace.jdId ?? null, workspace.resumeId ?? null,
        workspace.status, workspace.summary ?? null, JSON.stringify(workspace), now, workspace.updatedAt,
      ],
    );
    return workspace;
  }

  public async getWorkspace(userId: string, sessionId: string): Promise<CopilotWorkspace | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM copilot_workspace WHERE user_id = $1 AND session_id = $2 ORDER BY updated_at DESC LIMIT 1", [userId, sessionId]);
    return result.rows[0] ? toWorkspace(result.rows[0]) : null;
  }

  public async listRecentWorkspaces(userId: string, options: ListCopilotRecordsOptions = {}): Promise<CopilotWorkspace[]> {
    const result = await this.database.query<PgRow>("SELECT * FROM copilot_workspace WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2", [userId, options.limit ?? 50]);
    return result.rows.map(toWorkspace);
  }
}

export class PostgresCopilotActivityRepository {
  public constructor(private readonly database: Db) {}

  public async createActivity(activity: CopilotActivity): Promise<CopilotActivity> {
    await this.database.query(
      `INSERT INTO copilot_activity (id,user_id,session_id,type,title,description,entity_type,entity_id,metadata_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, metadata_json=EXCLUDED.metadata_json`,
      [
        activity.id, activity.userId, activity.sessionId ?? null, activity.type, activity.title,
        activity.description ?? null, activity.entityType ?? null, activity.entityId ?? null,
        JSON.stringify(activity.metadata ?? null), activity.createdAt,
      ],
    );
    return activity;
  }

  public async listActivities(userId: string, options: ListCopilotRecordsOptions & { sessionId?: string; type?: CopilotActivity["type"] } = {}): Promise<CopilotActivity[]> {
    const params: unknown[] = [userId];
    const clauses = ["user_id = $1"];
    if (options.sessionId) {
      params.push(options.sessionId);
      clauses.push(`session_id = $${params.length}`);
    }
    if (options.type) {
      params.push(options.type);
      clauses.push(`type = $${params.length}`);
    }
    params.push(options.limit ?? 50);
    const result = await this.database.query<PgRow>(
      `SELECT * FROM copilot_activity WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toActivity);
  }
}

function toSession(row: PgRow): CopilotSession {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    title: optionalText(row, "title") ?? null,
    targetRole: optionalText(row, "target_role") ?? null,
    resumeText: optionalText(row, "resume_text") ?? null,
    jdText: optionalText(row, "jd_text") ?? null,
    currentWorkspaceId: optionalText(row, "current_workspace_id") ?? null,
    status: text(row, "status") as CopilotSession["status"],
    resumeIngested: Boolean(row.resume_ingested),
    resumeDocumentIds: jsonValue<string[]>(row, "resume_document_ids_json", []),
    resumeArtifactIds: jsonValue<string[]>(row, "resume_artifact_ids_json", []),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function toMessage(row: PgRow): CopilotMessage {
  return normalizeCopilotMessage({
    id: text(row, "id"),
    sessionId: text(row, "session_id"),
    turnId: optionalText(row, "turn_id") ?? null,
    role: text(row, "role"),
    kind: optionalText(row, "kind") ?? "plain_text",
    content: text(row, "content"),
    metadata: jsonValue<Record<string, unknown> | undefined>(row, "metadata_json", undefined),
    createdAt: timestamp(row, "created_at"),
  });
}

function toTurn(row: PgRow): CopilotTurn {
  return normalizeCopilotTurn({
    id: text(row, "id"),
    sessionId: text(row, "session_id"),
    userMessageId: text(row, "user_message_id"),
    assistantMessageId: optionalText(row, "assistant_message_id") ?? null,
    intent: optionalText(row, "intent") ?? null,
    status: optionalText(row, "status") ?? "completed",
    error: optionalText(row, "error") ?? null,
    createdAt: timestamp(row, "created_at"),
    completedAt: optionalText(row, "completed_at") ?? null,
  });
}

function toWorkspace(row: PgRow): CopilotWorkspace {
  const raw = jsonValue<Record<string, unknown>>(row, "workspace_json", {});
  return normalizeCopilotWorkspace({
    id: text(row, "id"),
    sessionId: text(row, "session_id"),
    ...raw,
    updatedAt: timestamp(row, "updated_at"),
  })!;
}

function toActivity(row: PgRow): CopilotActivity {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    sessionId: optionalText(row, "session_id") ?? null,
    type: text(row, "type") as CopilotActivity["type"],
    title: text(row, "title"),
    description: optionalText(row, "description") ?? null,
    entityType: optionalText(row, "entity_type") as CopilotActivity["entityType"],
    entityId: optionalText(row, "entity_id") ?? null,
    metadata: jsonValue<Record<string, unknown> | undefined>(row, "metadata_json", undefined),
    createdAt: timestamp(row, "created_at"),
  };
}
