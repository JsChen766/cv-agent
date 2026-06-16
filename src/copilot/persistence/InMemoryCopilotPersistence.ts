import type {
  CopilotActivity,
  CopilotPersistence,
  CopilotWorkspaceRecord,
  ListCopilotRecordsOptions,
  ListCopilotSessionsOptions,
} from "./CopilotPersistence.js";
import type { CopilotMessage, CopilotSession, CopilotTurn, CopilotWorkspace } from "../types.js";
import { applySessionDisplay } from "../SessionDisplayProjector.js";

export class InMemoryCopilotPersistence implements CopilotPersistence {
  public readonly sessions = new InMemoryCopilotSessionRepository();
  public readonly messages = new InMemoryCopilotMessageRepository();
  public readonly turns = new InMemoryCopilotTurnRepository();
  public readonly workspaces = new InMemoryCopilotWorkspaceRepository();
  public readonly activities = new InMemoryCopilotActivityRepository();
}

export class InMemoryCopilotSessionRepository {
  private readonly sessions = new Map<string, CopilotSession>();

  public async createSession(session: CopilotSession): Promise<CopilotSession> {
    this.sessions.set(session.id, session);
    return applySessionDisplay(session);
  }

  public async getSession(userId: string, sessionId: string): Promise<CopilotSession | null> {
    const session = this.sessions.get(sessionId);
    return session?.userId === userId ? applySessionDisplay(session) : null;
  }

  public async updateSession(userId: string, sessionId: string, patch: Partial<CopilotSession>): Promise<CopilotSession | null> {
    const current = this.sessions.get(sessionId);
    if (!current || current.userId !== userId) return null;
    const next = { ...current, ...patch, id: current.id, userId: current.userId, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    this.sessions.set(sessionId, next);
    return applySessionDisplay(next);
  }

  public async listSessions(userId: string, options: ListCopilotSessionsOptions = {}): Promise<CopilotSession[]> {
    return limit(Array.from(this.sessions.values())
      .filter((session) => session.userId === userId && (!options.status || session.status === options.status))
      .sort(descUpdated)
      .map((session) => applySessionDisplay(session)), options.limit);
  }

  public archiveSession(userId: string, sessionId: string): Promise<CopilotSession | null> {
    return this.updateSession(userId, sessionId, { status: "archived" });
  }
}

export class InMemoryCopilotMessageRepository {
  private readonly messages = new Map<string, CopilotMessage & { userId: string }>();

  public async createMessage(message: CopilotMessage & { userId: string }): Promise<CopilotMessage> {
    this.messages.set(message.id, message);
    return stripUserId(message);
  }

  public async listMessages(userId: string, sessionId: string, options: ListCopilotRecordsOptions = {}): Promise<CopilotMessage[]> {
    return limit(Array.from(this.messages.values())
      .filter((message) => message.userId === userId && message.sessionId === sessionId)
      .sort(ascCreated)
      .map(stripUserId), options.limit);
  }

  public async getRecentMessages(userId: string, sessionId: string, limitCount: number): Promise<CopilotMessage[]> {
    return (await this.listMessages(userId, sessionId)).slice(-Math.max(0, limitCount));
  }
}

export class InMemoryCopilotTurnRepository {
  private readonly turns = new Map<string, CopilotTurn & { userId: string }>();

  public async createTurn(turn: CopilotTurn & { userId: string }): Promise<CopilotTurn> {
    this.turns.set(turn.id, turn);
    return stripUserId(turn);
  }

  public async updateTurn(userId: string, turnId: string, patch: Partial<CopilotTurn>): Promise<CopilotTurn | null> {
    const current = this.turns.get(turnId);
    if (!current || current.userId !== userId) return null;
    const next = { ...current, ...patch, id: current.id, userId: current.userId };
    this.turns.set(turnId, next);
    return stripUserId(next);
  }

  public async listTurns(userId: string, sessionId: string, options: ListCopilotRecordsOptions = {}): Promise<CopilotTurn[]> {
    return limit(Array.from(this.turns.values())
      .filter((turn) => turn.userId === userId && turn.sessionId === sessionId)
      .sort(ascCreated)
      .map(stripUserId), options.limit);
  }
}

export class InMemoryCopilotWorkspaceRepository {
  private readonly workspaces = new Map<string, CopilotWorkspaceRecord>();

  public async upsertWorkspace(userId: string, workspace: CopilotWorkspace): Promise<CopilotWorkspace> {
    const current = this.workspaces.get(workspace.id);
    this.workspaces.set(workspace.id, {
      ...workspace,
      userId,
      createdAt: current?.createdAt ?? new Date().toISOString(),
    });
    return workspace;
  }

  public async getWorkspace(userId: string, sessionId: string): Promise<CopilotWorkspace | null> {
    const workspace = this.workspaces.get(`ws-${sessionId}`);
    return workspace?.userId === userId ? stripUserId(workspace) : null;
  }

  public async listRecentWorkspaces(userId: string, options: ListCopilotRecordsOptions = {}): Promise<CopilotWorkspace[]> {
    return limit(Array.from(this.workspaces.values())
      .filter((workspace) => workspace.userId === userId)
      .sort(descUpdated)
      .map(stripUserId), options.limit);
  }
}

export class InMemoryCopilotActivityRepository {
  private readonly activities = new Map<string, CopilotActivity>();

  public async createActivity(activity: CopilotActivity): Promise<CopilotActivity> {
    this.activities.set(activity.id, activity);
    return activity;
  }

  public async listActivities(userId: string, options: ListCopilotRecordsOptions & { sessionId?: string; type?: CopilotActivity["type"] } = {}): Promise<CopilotActivity[]> {
    return limit(Array.from(this.activities.values())
      .filter((activity) => (
        activity.userId === userId &&
        (!options.sessionId || activity.sessionId === options.sessionId) &&
        (!options.type || activity.type === options.type)
      ))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), options.limit);
  }
}

function limit<T>(items: T[], count = 50): T[] {
  return items.slice(0, Math.max(0, count));
}

function ascCreated(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function descUpdated(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function stripUserId<T extends { userId: string }>(record: T): Omit<T, "userId"> {
  const { userId: _userId, ...rest } = record;
  return rest;
}
