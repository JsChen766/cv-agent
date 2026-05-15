import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresDocumentRepository,
  PostgresEvidenceRepository,
  PostgresExperienceRepository,
  PostgresGeneratedArtifactRepository,
  PostgresGenerationSessionRepository,
} from "../src/persistence/postgres/index.js";
import type { PostgresQueryResult } from "../src/persistence/postgres/PostgresDatabase.js";
import type { ExtractedTextDocument } from "../src/tools/document/types.js";
import type { Evidence, Experience, GeneratedArtifact } from "../src/knowledge/types.js";
import type { GenerationSession } from "../src/application/sessions/types.js";

class FakePostgresDatabase {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  public nextRows: QueryResultRow[] = [];

  public async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, params });
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

  it("stores generation_sessions with separate input summary and generation snapshot", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresGenerationSessionRepository(database);

    await repository.save(createGenerationSession());

    expect(database.queries[0].sql).toContain("generation");
    expect(database.queries[0].params[5]).toContain("createdFrom");
    expect(database.queries[0].params[6]).toContain("jdText");
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
