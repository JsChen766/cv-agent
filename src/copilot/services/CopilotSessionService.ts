import { randomUUID } from "node:crypto";
import type { CopilotMessage, CopilotSession, CopilotTurn } from "../types.js";
import type { CopilotPersistence, ListCopilotSessionsOptions } from "../persistence/index.js";

export class CopilotSessionService {
  public constructor(private readonly persistence: CopilotPersistence) {}

  public async getOrCreateSession(userId: string, input: {
    sessionId?: string;
    resumeText?: string;
    jdText?: string;
    targetRole?: string;
  }): Promise<CopilotSession> {
    if (input.sessionId) {
      const existing = await this.persistence.sessions.getSession(userId, input.sessionId);
      if (existing) {
        const patch: Partial<CopilotSession> = {};
        if (input.resumeText) patch.resumeText = input.resumeText;
        if (input.jdText) patch.jdText = input.jdText;
        if (input.targetRole) patch.targetRole = input.targetRole;
        return Object.keys(patch).length > 0
          ? (await this.persistence.sessions.updateSession(userId, existing.id, patch)) ?? existing
          : existing;
      }
    }

    const now = new Date().toISOString();
    return this.persistence.sessions.createSession({
      id: `cs-${randomUUID()}`,
      userId,
      title: input.targetRole ? `${input.targetRole} conversation` : "New Copilot chat",
      targetRole: input.targetRole ?? null,
      resumeText: input.resumeText ?? null,
      jdText: input.jdText ?? null,
      currentWorkspaceId: null,
      status: "active",
      resumeIngested: false,
      resumeDocumentIds: [],
      resumeArtifactIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  public getSession(userId: string, sessionId: string): Promise<CopilotSession | null> {
    return this.persistence.sessions.getSession(userId, sessionId);
  }

  public listSessions(userId: string, options?: ListCopilotSessionsOptions): Promise<CopilotSession[]> {
    return this.persistence.sessions.listSessions(userId, options);
  }

  public archiveSession(userId: string, sessionId: string): Promise<CopilotSession | null> {
    return this.persistence.sessions.archiveSession(userId, sessionId);
  }

  public updateSession(userId: string, sessionId: string, patch: Partial<CopilotSession>): Promise<CopilotSession | null> {
    return this.persistence.sessions.updateSession(userId, sessionId, patch);
  }

  public async saveMessage(userId: string, message: CopilotMessage): Promise<CopilotMessage> {
    await this.persistence.sessions.updateSession(userId, message.sessionId, { updatedAt: message.createdAt });
    return this.persistence.messages.createMessage({ ...message, userId });
  }

  public listMessages(userId: string, sessionId: string, limit?: number): Promise<CopilotMessage[]> {
    return this.persistence.messages.listMessages(userId, sessionId, { limit });
  }

  public getRecentMessages(userId: string, sessionId: string, limit: number): Promise<CopilotMessage[]> {
    return this.persistence.messages.getRecentMessages(userId, sessionId, limit);
  }

  public createTurn(userId: string, sessionId: string, userMessageId: string): Promise<CopilotTurn> {
    return this.persistence.turns.createTurn({
      id: `ct-${randomUUID()}`,
      userId,
      sessionId,
      userMessageId,
      status: "running",
      createdAt: new Date().toISOString(),
    });
  }

  public completeTurn(userId: string, turnId: string, assistantMessageId: string): Promise<CopilotTurn | null> {
    return this.persistence.turns.updateTurn(userId, turnId, {
      assistantMessageId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

  public failTurn(userId: string, turnId: string, error: string): Promise<CopilotTurn | null> {
    return this.persistence.turns.updateTurn(userId, turnId, {
      status: "failed",
      error,
      completedAt: new Date().toISOString(),
    });
  }

  public listTurns(userId: string, sessionId: string, limit?: number): Promise<CopilotTurn[]> {
    return this.persistence.turns.listTurns(userId, sessionId, { limit });
  }
}
