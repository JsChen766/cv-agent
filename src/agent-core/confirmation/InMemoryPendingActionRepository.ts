import type { PendingAction, PendingActionStatus } from "./PendingAction.js";
import type { PendingActionRepository } from "./PendingActionRepository.js";

export class InMemoryPendingActionRepository implements PendingActionRepository {
  private readonly actions = new Map<string, PendingAction>();

  public async create(action: PendingAction): Promise<PendingAction> {
    this.actions.set(action.id, action);
    return action;
  }

  public async getById(userId: string, id: string): Promise<PendingAction | undefined> {
    const action = this.actions.get(id);
    return action?.userId === userId ? action : undefined;
  }

  public async list(userId: string, sessionId?: string): Promise<PendingAction[]> {
    return Array.from(this.actions.values()).filter((action) => (
      action.userId === userId &&
      (!sessionId || action.sessionId === sessionId)
    ));
  }

  public async update(action: PendingAction): Promise<PendingAction> {
    this.actions.set(action.id, action);
    return action;
  }

  public async updateStatusIfCurrent(
    userId: string,
    id: string,
    currentStatus: PendingActionStatus,
    patch: Partial<PendingAction> & { status: PendingActionStatus },
  ): Promise<PendingAction | undefined> {
    const current = this.actions.get(id);
    if (!current || current.userId !== userId || current.status !== currentStatus) {
      return undefined;
    }
    const next = { ...current, ...patch, id: current.id, userId: current.userId };
    this.actions.set(id, next);
    return next;
  }
}
