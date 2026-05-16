import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresDocumentRepository,
  PostgresArtifactDecisionRepository,
  PostgresEvidenceRepository,
  PostgresExperienceRepository,
  PostgresGeneratedArtifactRepository,
  PostgresGenerationSessionRepository,
} from "../src/persistence/postgres/index.js";
import type { PostgresQueryResult } from "../src/persistence/postgres/PostgresDatabase.js";
import type { ExtractedTextDocument } from "../src/tools/document/types.js";
import type { Evidence, Experience, GeneratedArtifact } from "../src/knowledge/types.js";
import type { GenerationSession } from "../src/application/sessions/types.js";
import type { ArtifactDecisionRecord } from "../src/application/decisions/index.js";

class FakePostgresDatabase {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  public nextRows: QueryResultRow[] = [];
  private readonly artifactDecisionIds = new Set<string>();

  public async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, params });
    if (sql.includes("INSERT INTO artifact_decisions")) {
      const id = params[0];
      if (typeof id === "string") {
        if (this.artifactDecisionIds.has(id)) {
          throw new Error(`duplicate key value violates unique constraint artifact_decisions_pkey: ${id}`);
        }
        this.artifactDecisionIds.add(id);
      }
    }
    return {
      rows: this.nextRows as Row[],
      rowCount: this.nextRows.length,
    };
  }
}

describe("PostgreSQL repositories", () => {
  it("sends document upsert SQL and JSON metadata through the database boundary", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresDocumentRepository(database);
    const document: ExtractedTextDocument = {
      documentId: "doc-1",
      userId: "user-1",
      sourceType: "markdown",
      fileName: "resume.md",
      mimeType: "text/markdown",
      text: "Built React systems.",
      textPreview: "Built React systems.",
      textLength: 20,
      sourceRef: "upload:resume.md",
      metadata: {
        parser: "markdown",
        wordCount: 3,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    await repository.save(document);

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].sql).toContain("INSERT INTO documents");
    expect(database.queries[0].sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(database.queries[0].params[0]).toBe("doc-1");
    expect(database.queries[0].params[1]).toBe("user-1");
    expect(database.queries[0].params[13]).toBe(JSON.stringify(document.metadata));
  });

  it("isolates document reads by user id", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresDocumentRepository(database);

    await repository.getById("user-1", "doc-1");
    await repository.listByUserId("user-1");

    expect(database.queries[0].sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(database.queries[0].params).toEqual(["user-1", "doc-1"]);
    expect(database.queries[1].sql).toContain("WHERE user_id = $1");
    expect(database.queries[1].params).toEqual(["user-1"]);
  });

  it("writes source_document_id and metadata for experiences", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresExperienceRepository(database);
    const experience = createExperience();

    await repository.save(experience);

    expect(database.queries[0].sql).toContain("source_document_id");
    expect(database.queries[0].params[11]).toBe("doc-1");
    expect(database.queries[0].params[12]).toBe(JSON.stringify({ sourceDocumentId: "doc-1" }));
  });

  it("writes source_document_id and metadata for evidences", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresEvidenceRepository(database);
    const evidence = createEvidence();

    await repository.save(evidence);

    expect(database.queries[0].sql).toContain("source_document_id");
    expect(database.queries[0].params[3]).toBe("doc-1");
    expect(database.queries[0].params[9]).toBe(JSON.stringify({ sourceDocumentId: "doc-1" }));
  });

  it("adds user-scoped experience and generated artifact lookups", async () => {
    const database = new FakePostgresDatabase();
    const experiences = new PostgresExperienceRepository(database);
    const artifacts = new PostgresGeneratedArtifactRepository(database);

    await experiences.getByIdForUser("user-1", "exp-1");
    await artifacts.getByIdForUser("user-1", "artifact-1");

    expect(database.queries[0].sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(database.queries[0].params).toEqual(["user-1", "exp-1"]);
    expect(database.queries[1].sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(database.queries[1].params).toEqual(["user-1", "artifact-1"]);
  });

  it("uses user-scoped delete SQL with WHERE user_id = $1 AND id = $2", async () => {
    const database = new FakePostgresDatabase();
    const experiences = new PostgresExperienceRepository(database);
    const artifacts = new PostgresGeneratedArtifactRepository(database);

    await experiences.deleteForUser("user-1", "exp-1");
    await artifacts.deleteForUser("user-1", "artifact-1");

    expect(database.queries[0].sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(database.queries[0].params).toEqual(["user-1", "exp-1"]);
    expect(database.queries[1].sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(database.queries[1].params).toEqual(["user-1", "artifact-1"]);
  });

  it("stores generation_sessions with separate input summary and generation snapshot", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresGenerationSessionRepository(database);

    await repository.save(createGenerationSession());

    expect(database.queries[0].sql).toContain("generation");
    expect(database.queries[0].params[5]).toContain("createdFrom");
    expect(database.queries[0].params[6]).toContain("jdText");
  });

  it("stores and lists artifact decisions with the expanded decision shape", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresArtifactDecisionRepository(database);
    const record: ArtifactDecisionRecord = {
      id: "decision-1",
      userId: "user-1",
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "confirm_metric",
      reason: "User confirmed metric.",
      selectedVariantId: "artifact-variant-1",
      confirmation: {
        metric: "report preparation time",
        value: "from 2 hours to 20 minutes",
        explanation: "Confirmed by internal workflow logs.",
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    await repository.save(record);

    expect(database.queries[0].sql).toContain("INSERT INTO artifact_decisions");
    expect(database.queries[0].sql).toContain("decision");
    expect(database.queries[0].sql).toContain("selected_variant_id");
    expect(database.queries[0].sql).toContain("confirmation_json");
    expect(database.queries[0].sql).not.toContain("ON CONFLICT");
    expect(database.queries[0].params).toEqual([
      "decision-1",
      "user-1",
      "artifact-1",
      "session-1",
      "confirm_metric",
      "User confirmed metric.",
      "artifact-variant-1",
      JSON.stringify(record.confirmation),
      "2024-01-01T00:00:00.000Z",
    ]);

    database.nextRows = [{
      id: "decision-1",
      user_id: "user-1",
      artifact_id: "artifact-1",
      session_id: "session-1",
      decision: "confirm_metric",
      reason: "User confirmed metric.",
      selected_variant_id: "artifact-variant-1",
      confirmation_json: record.confirmation,
      created_at: "2024-01-01T00:00:00.000Z",
    }];

    await expect(repository.listByArtifactId("user-1", "artifact-1")).resolves.toEqual([record]);
    expect(database.queries[1].sql).toContain("WHERE user_id = $1 AND artifact_id = $2");
    expect(database.queries[1].params).toEqual(["user-1", "artifact-1"]);

    await repository.listBySessionId("user-1", "session-1");
    expect(database.queries[2].sql).toContain("WHERE user_id = $1 AND session_id = $2");
    expect(database.queries[2].params).toEqual(["user-1", "session-1"]);
  });

  it("lets PostgreSQL primary key reject duplicate artifact decision ids", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresArtifactDecisionRepository(database);
    const record: ArtifactDecisionRecord = {
      id: "decision-duplicate",
      userId: "user-1",
      artifactId: "artifact-1",
      decision: "accept",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    await repository.save(record);
    await expect(repository.save({
      ...record,
      decision: "reject",
    })).rejects.toThrow("duplicate key value violates unique constraint artifact_decisions_pkey");

    expect(database.queries).toHaveLength(2);
    expect(database.queries[0].sql).not.toContain("ON CONFLICT");
    expect(database.queries[1].sql).not.toContain("ON CONFLICT");
    expect(database.queries[0].params[0]).toBe("decision-duplicate");
    expect(database.queries[1].params[0]).toBe("decision-duplicate");
  });
});

function createExperience(): Experience {
  return {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme",
    role: "Frontend Engineer",
    summary: "Built React systems.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "s", task: "t", action: "a", result: "r" },
    evidenceIds: ["evidence-1"],
    skillIds: ["skill-1"],
    confidence: 0.9,
    sourceDocumentId: "doc-1",
    metadata: { sourceDocumentId: "doc-1" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function createEvidence(): Evidence {
  return {
    id: "evidence-1",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "resume",
    evidenceType: "project",
    sourceRef: "resume.md",
    excerpt: "Built React systems.",
    confidence: 0.9,
    sourceDocumentId: "doc-1",
    metadata: { sourceDocumentId: "doc-1" },
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function createArtifact(): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Built React systems.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["evidence-1"],
    matchedSkillIds: ["skill-1"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Frontend Engineer",
    scores: { overall: 0.9, requirementMatch: 0.9, evidenceStrength: 0.9 },
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function createGenerationSession(): GenerationSession {
  const artifact = createArtifact();
  return {
    id: "session-1",
    userId: "user-1",
    jdId: "jd-1",
    generation: {
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Need React.",
      targetRole: "Frontend Engineer",
      requirements: [],
      retrievedExperiences: [],
      artifacts: [{
        artifact,
        evidenceChain: {
          id: "chain-1",
          artifact,
          summary: "summary",
          requirementMatches: [],
          sourceExperiences: [],
          sourceEvidences: [],
          sourceSkills: [],
          risk: {
            level: "low",
            truthfulnessRisk: "low",
            exaggerationRisk: "low",
            missingEvidenceClaims: [],
            exaggerationWarnings: [],
            notes: [],
          },
          scores: artifact.scores,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
        graphView: { nodes: [], edges: [] },
      }],
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
    },
    artifactDecisions: [],
    coverageGapDecisions: [],
    supplementalArtifactDrafts: [],
    status: "completed",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}
