import type {
  GraphViewSnapshot,
  GraphViewSnapshotRepository,
} from "../../persistence/repositories.js";
import type { GraphViewQueryResult } from "./types.js";

export type GraphScopeType = GraphViewSnapshot["scopeType"];

export class GraphViewQueryService {
  public constructor(
    private readonly repository: GraphViewSnapshotRepository,
  ) {}

  public async listByScope(
    userId: string,
    scopeType: GraphScopeType,
    scopeId: string,
  ): Promise<GraphViewQueryResult> {
    const graphViews = await this.repository.listByScope(userId, scopeType, scopeId);
    return this.toResult(graphViews);
  }

  public async getLatestUserGraph(userId: string): Promise<GraphViewQueryResult> {
    const graphViews = await this.repository.listByScope(userId, "user", userId);
    return this.toResult(graphViews.slice(-1));
  }

  private toResult(graphViews: GraphViewSnapshot[]): GraphViewQueryResult {
    const warnings = graphViews.length === 0 ? ["No graph snapshots found for the requested scope."] : [];
    return {
      graphViews,
      summary: `Found ${graphViews.length} graph views for the requested scope.`,
      warnings,
    };
  }
}
