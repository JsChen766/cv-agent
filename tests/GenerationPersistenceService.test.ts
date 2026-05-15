import { describe, expect, it } from "vitest";
import { GenerationPersistenceService } from "../src/application/generation/index.js";
import type { GenerateResumeResult } from "../src/application/ResumeGenerationService.js";
import { createPostgresGenerationPersistenceService } from "../src/persistence/postgres/index.js";
import type { PostgresQueryable, PostgresQueryResult } from "../src/persistence/postgres/PostgresDatabase.js";
import type {
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
  GenerationArtifactBundleRecord,
  GenerationArtifactBundleRepository,
  GraphViewSnapshot,
  GraphViewSnapshotRepository,
  PersistedGenerationSessionRepository,
} from "../src/persistence/repositories.js";
import type { GenerationSession, GenerationSessionStatus } from "../src/application/sessions/types.js";
import type { Evidence, EvidenceChain, Experience, GeneratedArtifact, GraphView, JDRequirement, Skill } from "../src/knowledge/types.js";

class FakeSessionRepository implements PersistedGenerationSessionRepository {
  public saved: GenerationSession[] = [];

  public async save(session: GenerationSession): Promise<void> {
    this.saved.push(session);
  }

  public async getById(_userId: string, _id: string): Promise<GenerationSession | null> {
    return null;
  }

  public async listByUserId(_userId: string): Promise<GenerationSession[]> {
    return [];
  }

  public async updateStatus(_userId: string, _id: string, _status: GenerationSessionStatus): Promise<void> {}
}

class FakeEvidenceChainSnapshotRepository implements EvidenceChainSnapshotRepository {
  public saved: EvidenceChainSnapshot[] = [];

  public async save(snapshot: EvidenceChainSnapshot): Promise<void> {
    this.saved.push(snapshot);
  }

  public async getById(_userId: string, _id: string): Promise<EvidenceChainSnapshot | null> {
    return null;
  }

  public async listBySessionId(_userId: string, _sessionId: string): Promise<EvidenceChainSnapshot[]> {
    return [];
  }

  public async listByArtifactId(_userId: string, _artifactId: string): Promise<EvidenceChainSnapshot[]> {
    return [];
  }
}

class ThrowingEvidenceChainSnapshotRepository extends FakeEvidenceChainSnapshotRepository {
  public override async save(_snapshot: EvidenceChainSnapshot): Promise<void> {
    throw new Error("snapshot save failed");
  }
}

class FakeGraphViewSnapshotRepository implements GraphViewSnapshotRepository {
  public saved: GraphViewSnapshot[] = [];

  public async save(snapshot: GraphViewSnapshot): Promise<void> {
    this.saved.push(snapshot);
  }

  public async getById(_userId: string, _id: string): Promise<GraphViewSnapshot | null> {
    return null;
  }

  public async listByScope(_userId: string, _scopeType: string, _scopeId: string): Promise<GraphViewSnapshot[]> {
    return [];
  }
}

class FakeBundleRepository implements GenerationArtifactBundleRepository {
  public saved: GenerationArtifactBundleRecord[] = [];

  public async save(bundle: GenerationArtifactBundleRecord): Promise<void> {
    this.saved.push(bundle);
  }

  public async listBySessionId(_userId: string, _sessionId: string): Promise<GenerationArtifactBundleRecord[]> {
    return [];
  }
}

describe("GenerationPersistenceService", () => {
  it("persists generation session, snapshots, and artifact bundles", async () => {
    const sessions = new FakeSessionRepository();
    const chains = new FakeEvidenceChainSnapshotRepository();
    const graphs = new FakeGraphViewSnapshotRepository();
    const bundles = new FakeBundleRepository();
    const service = new GenerationPersistenceService(sessions, chains, graphs, bundles);

    const result = await service.persist(createGenerateResumeResult(), { source: "test" });

    expect(sessions.saved).toHaveLength(1);
    expect(chains.saved).toHaveLength(1);
    expect(graphs.saved).toHaveLength(1);
    expect(bundles.saved).toHaveLength(1);
    expect(result.session.status).toBe("completed");
    expect(result.session.generation.artifacts[0].artifact.id).toBe("artifact-1");
    expect(bundles.saved[0].evidenceChainSnapshotId).toBe(chains.saved[0].id);
    expect(bundles.saved[0].graphViewSnapshotId).toBe(graphs.saved[0].id);
    expect(bundles.saved[0].metadata).toEqual({ source: "test" });
  });

  it("stops later saves when a snapshot repository fails", async () => {
    const sessions = new FakeSessionRepository();
    const chains = new ThrowingEvidenceChainSnapshotRepository();
    const graphs = new FakeGraphViewSnapshotRepository();
    const bundles = new FakeBundleRepository();
    const service = new GenerationPersistenceService(sessions, chains, graphs, bundles);

    await expect(service.persist(createGenerateResumeResult())).rejects.toThrow("snapshot save failed");
    expect(sessions.saved).toHaveLength(1);
    expect(graphs.saved).toHaveLength(0);
    expect(bundles.saved).toHaveLength(0);
  });

  it("uses a PostgreSQL transaction-aware factory for generation persistence", async () => {
    const database = new FakeTransactionDatabase();
    const service = createPostgresGenerationPersistenceService(database);

    await service.persist(createGenerateResumeResult());

    expect(database.transactionCalled).toBe(true);
    expect(database.client.queries.some((query) => query.sql.includes("INSERT INTO generation_sessions"))).toBe(true);
    expect(database.client.queries.some((query) => query.sql.includes("INSERT INTO evidence_chain_snapshots"))).toBe(true);
  });
});

class FakeTransactionDatabase {
  public transactionCalled = false;
  public readonly client = new FakeTransactionClient();

  public async transaction<T>(callback: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    this.transactionCalled = true;
    return callback(this.client);
  }
}

class FakeTransactionClient implements PostgresQueryable {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  public async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
}

function createGenerateResumeResult(): GenerateResumeResult {
  const now = "2024-01-01T00:00:00.000Z";
  const experience: Experience = {
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
    createdAt: now,
    updatedAt: now,
  };
  const evidence: Evidence = {
    id: "evidence-1",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "resume",
    evidenceType: "project",
    sourceRef: "resume.md",
    excerpt: "Built React systems.",
    confidence: 0.9,
    createdAt: now,
  };
  const skill: Skill = {
    id: "skill-1",
    userId: "user-1",
    name: "React",
    category: "technical",
    evidenceIds: ["evidence-1"],
    createdAt: now,
    updatedAt: now,
  };
  const requirement: JDRequirement = {
    id: "req-1",
    userId: "user-1",
    jdId: "jd-1",
    description: "React experience",
    requiredSkillIds: ["skill-1"],
    weight: 1,
    createdAt: now,
  };
  const artifact: GeneratedArtifact = {
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
    createdAt: now,
    updatedAt: now,
  };
  const chain: EvidenceChain = {
    id: "chain-1",
    artifact,
    summary: "Supported by React evidence.",
    requirementMatches: [{
      requirement,
      matchedSkills: [skill],
      matchedExperiences: [experience],
      matchedEvidences: [evidence],
      matchScore: 0.9,
      matchReason: "React match",
    }],
    sourceExperiences: [experience],
    sourceEvidences: [evidence],
    sourceSkills: [skill],
    risk: {
      level: "low",
      truthfulnessRisk: "low",
      exaggerationRisk: "low",
      missingEvidenceClaims: [],
      exaggerationWarnings: [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: now,
  };
  const graph: GraphView = {
    nodes: [{ id: "artifact-1", type: "artifact", label: "Artifact", detail: "Built React systems." }],
    edges: [],
  };

  return {
    userId: "user-1",
    jdId: "jd-1",
    jdText: "Need React.",
    targetRole: "Frontend Engineer",
    requirements: [requirement],
    retrievedExperiences: [{
      experience,
      evidences: [evidence],
      skills: [skill],
      matchedEvidences: [evidence],
      matchedSkills: [skill],
      matchedRequirements: [requirement],
      matchScore: 0.9,
      matchedRequirementIds: ["req-1"],
      matchedEvidenceIds: ["evidence-1"],
      matchedSkillIds: ["skill-1"],
      reason: "Matched React",
    }],
    artifacts: [artifact],
    evidenceChains: [chain],
    graphViews: [graph],
    coverageReport: {
      id: "coverage-1",
      jdId: "jd-1",
      userId: "user-1",
      totalRequirements: 1,
      coveredRequirementIds: ["req-1"],
      weaklyCoveredRequirementIds: [],
      evidenceAvailableButNotUsedRequirementIds: [],
      noEvidenceRequirementIds: [],
      notTargetedRequirementIds: [],
      items: [{
        requirement,
        status: "covered",
        coveredByArtifactIds: ["artifact-1"],
        supportingEvidenceIds: ["evidence-1"],
        supportingSkillIds: ["skill-1"],
        reason: "Covered",
        suggestions: [],
      }],
      summary: "Covered.",
      createdAt: now,
    },
    coverageGapReport: {
      id: "gap-report-1",
      userId: "user-1",
      jdId: "jd-1",
      items: [],
      supplementalArtifactCount: 0,
      evidenceRequestCount: 0,
      summary: "No gaps.",
      createdAt: now,
    },
    critiqueReport: {
      id: "critique-1",
      userId: "user-1",
      jdId: "jd-1",
      items: [],
      summary: "Looks good.",
      createdAt: now,
    },
    createdAt: now,
  };
}
