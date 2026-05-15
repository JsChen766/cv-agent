import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { createPostgresGenerationPersistenceService } from "../src/persistence/postgres/PostgresGenerationPersistenceService.js";
import type { PostgresQueryResult, PostgresQueryable } from "../src/persistence/postgres/PostgresDatabase.js";
import type { GenerateResumeResult } from "../src/application/ResumeGenerationService.js";

describe("PostgresGenerationPersistenceService", () => {
  it("invokes database.transaction and executes repository writes inside the callback", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    let transactionCalled = false;
    let clientPassedToCallback: PostgresQueryable | null = null;

    const transactionClient: PostgresQueryable = {
      query: async <Row extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PostgresQueryResult<Row>> => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };

    const fakeDb = {
      transaction: async <T>(
        callback: (client: PostgresQueryable) => Promise<T>,
      ): Promise<T> => {
        transactionCalled = true;
        clientPassedToCallback = transactionClient;
        return callback(transactionClient);
      },
    };

    const service = createPostgresGenerationPersistenceService(fakeDb);

    const result: GenerateResumeResult = {
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Need React.",
      targetRole: "Frontend Engineer",
      requirements: [],
      retrievedExperiences: [],
      artifacts: [
        {
          id: "artifact-1",
          userId: "user-1",
          type: "resume_bullet" as const,
          content: "Built React systems.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["evidence-1"],
          matchedSkillIds: ["skill-1"],
          targetJDId: "jd-1",
          targetRequirementIds: ["req-1"],
          targetRole: "Frontend Engineer",
          scores: { overall: 0.9, requirementMatch: 0.9, evidenceStrength: 0.9 },
          status: "ready" as const,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      evidenceChains: [
        {
          id: "chain-1",
          artifact: {
            id: "artifact-1",
            userId: "user-1",
            type: "resume_bullet" as const,
            content: "Built React systems.",
            sourceExperienceIds: ["exp-1"],
            sourceEvidenceIds: ["evidence-1"],
            matchedSkillIds: ["skill-1"],
            targetJDId: "jd-1",
            targetRequirementIds: ["req-1"],
            targetRole: "Frontend Engineer",
            scores: { overall: 0.9, requirementMatch: 0.9, evidenceStrength: 0.9 },
            status: "ready" as const,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
          summary: "Supported.",
          requirementMatches: [],
          sourceExperiences: [],
          sourceEvidences: [],
          sourceSkills: [],
          risk: {
            level: "low" as const,
            truthfulnessRisk: "low" as const,
            exaggerationRisk: "low" as const,
            missingEvidenceClaims: [],
            exaggerationWarnings: [],
            notes: [],
          },
          scores: { overall: 0.9, requirementMatch: 0.9, evidenceStrength: 0.9 },
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      graphViews: [{ nodes: [], edges: [] }],
      coverageReport: {
        id: "coverage-1",
        jdId: "jd-1",
        userId: "user-1",
        totalRequirements: 0,
        coveredRequirementIds: [],
        weaklyCoveredRequirementIds: [],
        evidenceAvailableButNotUsedRequirementIds: [],
        noEvidenceRequirementIds: [],
        notTargetedRequirementIds: [],
        items: [],
        summary: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      coverageGapReport: {
        id: "gap-1",
        userId: "user-1",
        jdId: "jd-1",
        items: [],
        supplementalArtifactCount: 0,
        evidenceRequestCount: 0,
        summary: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      critiqueReport: {
        id: "critique-1",
        userId: "user-1",
        jdId: "jd-1",
        items: [],
        summary: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    const persisted = await service.persist(result, { demo: true });

    expect(transactionCalled).toBe(true);
    // session INSERT + chain INSERT + graph INSERT + bundle INSERT = 4 writes
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries.some((q) => q.sql.includes("generation_sessions"))).toBe(true);
    expect(queries.some((q) => q.sql.includes("evidence_chain_snapshots"))).toBe(true);
    expect(queries.some((q) => q.sql.includes("graph_view_snapshots"))).toBe(true);
    expect(queries.some((q) => q.sql.includes("generation_artifact_bundles"))).toBe(true);
    expect(persisted.session.userId).toBe("user-1");
    expect(persisted.evidenceChainSnapshots).toHaveLength(1);
    expect(persisted.graphViewSnapshots).toHaveLength(1);
    expect(persisted.bundles).toHaveLength(1);
  });

  it("propagates transaction errors outward", async () => {
    const fakeDb = {
      transaction: async <T>(_callback: (client: PostgresQueryable) => Promise<T>): Promise<T> => {
        throw new Error("ROLLBACK");
      },
    };

    const service = createPostgresGenerationPersistenceService(fakeDb);

    const result: GenerateResumeResult = {
      userId: "user-1",
      jdId: "jd-1",
      jdText: "",
      targetRole: "",
      requirements: [],
      retrievedExperiences: [],
      artifacts: [],
      evidenceChains: [],
      graphViews: [],
      coverageReport: {
        id: "coverage-1",
        jdId: "jd-1",
        userId: "user-1",
        totalRequirements: 0,
        coveredRequirementIds: [],
        weaklyCoveredRequirementIds: [],
        evidenceAvailableButNotUsedRequirementIds: [],
        noEvidenceRequirementIds: [],
        notTargetedRequirementIds: [],
        items: [],
        summary: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      coverageGapReport: {
        id: "gap-1",
        userId: "user-1",
        jdId: "jd-1",
        items: [],
        supplementalArtifactCount: 0,
        evidenceRequestCount: 0,
        summary: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      critiqueReport: {
        id: "critique-1",
        userId: "user-1",
        jdId: "jd-1",
        items: [],
        summary: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    await expect(service.persist(result)).rejects.toThrow("ROLLBACK");
  });
});
