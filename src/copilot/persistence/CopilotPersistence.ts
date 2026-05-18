import type {
  CopilotMessage,
  CopilotSession,
  CopilotTurn,
  CopilotWorkspace,
} from "../types.js";

export type CopilotSessionStatus = "active" | "archived" | "deleted";
export type CopilotActivityType =
  | "chat"
  | "generation"
  | "decision"
  | "revision"
  | "import"
  | "save_experience"
  | "save_resume"
  | "open_workspace";

export type CopilotActivity = {
  id: string;
  userId: string;
  sessionId?: string | null;
  type: CopilotActivityType;
  title: string;
  description?: string | null;
  entityType?: "experience" | "jd" | "resume" | "generation" | "session" | "variant" | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type ListCopilotSessionsOptions = {
  limit?: number;
  status?: CopilotSessionStatus;
};

export type ListCopilotRecordsOptions = {
  limit?: number;
};

export type CopilotWorkspaceRecord = CopilotWorkspace & {
  userId: string;
  createdAt: string;
};

export interface CopilotSessionRepository {
  createSession(session: CopilotSession): Promise<CopilotSession>;
  getSession(userId: string, sessionId: string): Promise<CopilotSession | null>;
  updateSession(userId: string, sessionId: string, patch: Partial<CopilotSession>): Promise<CopilotSession | null>;
  listSessions(userId: string, options?: ListCopilotSessionsOptions): Promise<CopilotSession[]>;
  archiveSession(userId: string, sessionId: string): Promise<CopilotSession | null>;
}

export interface CopilotMessageRepository {
  createMessage(message: CopilotMessage & { userId: string }): Promise<CopilotMessage>;
  listMessages(userId: string, sessionId: string, options?: ListCopilotRecordsOptions): Promise<CopilotMessage[]>;
  getRecentMessages(userId: string, sessionId: string, limit: number): Promise<CopilotMessage[]>;
}

export interface CopilotTurnRepository {
  createTurn(turn: CopilotTurn & { userId: string }): Promise<CopilotTurn>;
  updateTurn(userId: string, turnId: string, patch: Partial<CopilotTurn>): Promise<CopilotTurn | null>;
  listTurns(userId: string, sessionId: string, options?: ListCopilotRecordsOptions): Promise<CopilotTurn[]>;
}

export interface CopilotWorkspaceRepository {
  upsertWorkspace(userId: string, workspace: CopilotWorkspace): Promise<CopilotWorkspace>;
  getWorkspace(userId: string, sessionId: string): Promise<CopilotWorkspace | null>;
  listRecentWorkspaces(userId: string, options?: ListCopilotRecordsOptions): Promise<CopilotWorkspace[]>;
}

export interface CopilotActivityRepository {
  createActivity(activity: CopilotActivity): Promise<CopilotActivity>;
  listActivities(userId: string, options?: ListCopilotRecordsOptions & { sessionId?: string; type?: CopilotActivityType }): Promise<CopilotActivity[]>;
}

export type CopilotPersistence = {
  sessions: CopilotSessionRepository;
  messages: CopilotMessageRepository;
  turns: CopilotTurnRepository;
  workspaces: CopilotWorkspaceRepository;
  activities: CopilotActivityRepository;
};
