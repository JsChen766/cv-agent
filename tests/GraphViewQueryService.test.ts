import { describe, expect, it } from "vitest";
import { GraphViewQueryService } from "../src/application/query/index.js";
import type {
  GraphViewSnapshot,
  GraphViewSnapshotRepository,
} from "../src/persistence/repositories.js";
import { createGraphViewSnapshot } from "./queryFixtures.js";

class FakeGraphViewSnapshotRepository implements GraphViewSnapshotRepository {
  public constructor(private readonly snapshots: GraphViewSnapshot[]) {}

  public async save(snapshot: GraphViewSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }

  public async getById(userId: string, id: string): Promise<GraphViewSnapshot | null> {
    return this.snapshots.find((snapshot) => snapshot.userId === userId && snapshot.id === id) ?? null;
  }

  public async listByScope(userId: string, scopeType: string, scopeId: string): Promise<GraphViewSnapshot[]> {
    return this.snapshots.filter((snapshot) => (
      snapshot.userId === userId &&
      snapshot.scopeType === scopeType &&
      snapshot.scopeId === scopeId
    ));
  }
}

describe("GraphViewQueryService", () => {
  it("lists graph view snapshots by scope", async () => {
    const service = new GraphViewQueryService(new FakeGraphViewSnapshotRepository([
      createGraphViewSnapshot({ id: "graph-1", userId: "user-1", scopeType: "artifact", scopeId: "artifact-1" }),
      createGraphViewSnapshot({ id: "graph-2", userId: "user-2", scopeType: "artifact", scopeId: "artifact-1" }),
    ]));

    const result = await service.listByScope("user-1", "artifact", "artifact-1");

    expect(result.graphViews).toHaveLength(1);
    expect(result.graphViews[0]?.id).toBe("graph-1");
    expect(result.warnings).toEqual([]);
  });

  it("returns a warning when no graph snapshots exist", async () => {
    const service = new GraphViewQueryService(new FakeGraphViewSnapshotRepository([]));

    const result = await service.listByScope("user-1", "artifact", "missing-artifact");

    expect(result.graphViews).toEqual([]);
    expect(result.warnings).toContain("No graph snapshots found for the requested scope.");
  });
});
