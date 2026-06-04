import type { PendingAction, PendingActionStatus } from "./PendingAction.js";

export interface PendingActionRepository {
  create(action: PendingAction): Promise<PendingAction>;
  getById(userId: string, id: string): Promise<PendingAction | undefined>;
  list(userId: string, sessionId?: string): Promise<PendingAction[]>;
  update(action: PendingAction): Promise<PendingAction>;
  updateStatusIfCurrent(
    userId: string,
    id: string,
    currentStatus: PendingActionStatus,
    patch: Partial<PendingAction> & { status: PendingActionStatus },
  ): Promise<PendingAction | undefined>;
}
