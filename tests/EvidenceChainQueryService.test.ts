import { describe, expect, it } from "vitest";
import { EvidenceChainQueryService } from "../src/application/query/index.js";
import type {
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
} from "../src/persistence/repositories.js";
import { createEvidenceChainSnapshot } from "./queryFixtures.js";

class FakeEvidenceChainSnapshotRepository implements EvidenceChainSnapshotRepository {
  public constructor(private readonly snapshots: EvidenceChainSnapshot[]) {}

  public async save(snapshot: EvidenceChainSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }

  public async getById(userId: string, id: string): Promise<EvidenceChainSnapshot | null> {
    return this.snapshots.find((snapshot) => snapshot.userId === userId && snapshot.id === id) ?? null;
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<EvidenceChainSnapshot[]> {
    return this.snapshots.filter((snapshot) => snapshot.userId === userId && snapshot.sessionId === sessionId);
  }

  public async listByArtifactId(userId: string, artifactId: string): Promise<EvidenceChainSnapshot[]> {
    return this.snapshots.filter((snapshot) => snapshot.userId === userId && snapshot.artifactId === artifactId);
  }
}

describe("EvidenceChainQueryService", () => {
  it("lists evidence chain snapshots by session id", async () => {
    const service = new EvidenceChainQueryService(new FakeEvidenceChainSnapshotRepository([
      createEvidenceChainSnapshot({ id: "snapshot-1", userId: "user-1", sessionId: "session-1" }),
      createEvidenceChainSnapshot({ id: "snapshot-2", userId: "user-2", sessionId: "session-1" }),
    ]));

    const result = await service.listBySessionId("user-1", "session-1");

    expect(result.evidenceChains).toHaveLength(1);
    expect(result.evidenceChains[0]?.id).toBe("snapshot-1");
    expect(result.summary).toContain("Found 1 evidence chains");
  });
});
