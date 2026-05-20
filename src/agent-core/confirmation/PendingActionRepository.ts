import type { PendingAction } from "./PendingAction.js";

export interface PendingActionRepository {
  create(action: PendingAction): Promise<PendingAction>;
  getById(userId: string, id: string): Promise<PendingAction | undefined>;
  list(userId: string, sessionId?: string): Promise<PendingAction[]>;
  update(action: PendingAction): Promise<PendingAction>;
}
