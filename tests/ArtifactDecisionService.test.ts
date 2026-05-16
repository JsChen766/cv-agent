import { describe, expect, it } from "vitest";
import {
  ArtifactDecisionService,
  InMemoryArtifactDecisionRepository,
} from "../src/application/decisions/index.js";

describe("ArtifactDecisionService", () => {
  it("records accept and reject decisions", async () => {
    const service = new ArtifactDecisionService(new InMemoryArtifactDecisionRepository());

    const accepted = await service.record({
      userId: "user-1",
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "accept",
    });
    const rejected = await service.record({
      userId: "user-1",
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "reject",
      reason: "Too broad.",
    });

    expect(accepted.id).toMatch(/^decision-/);
    expect(rejected.reason).toBe("Too broad.");
    await expect(service.listByArtifactId("user-1", "artifact-1")).resolves.toEqual([
      accepted,
      rejected,
    ]);
  });

  it("records confirm_metric and lists by session", async () => {
    const service = new ArtifactDecisionService(new InMemoryArtifactDecisionRepository());

    const record = await service.record({
      userId: "user-1",
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "confirm_metric",
      confirmation: {
        metric: "report preparation time",
        value: "from 2 hours to 20 minutes",
        explanation: "Confirmed by internal workflow logs.",
      },
    });

    expect(record.confirmation).toEqual({
      metric: "report preparation time",
      value: "from 2 hours to 20 minutes",
      explanation: "Confirmed by internal workflow logs.",
    });
    await expect(service.listBySessionId("user-1", "session-1")).resolves.toEqual([record]);
    await expect(service.listBySessionId("user-2", "session-1")).resolves.toEqual([]);
  });
});
