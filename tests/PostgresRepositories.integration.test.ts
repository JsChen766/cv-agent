import { describe, expect, it } from "vitest";
import {
  PostgresDatabase,
  PostgresDocumentRepository,
  PostgresEvidenceChainSnapshotRepository,
  PostgresEvidenceRepository,
  PostgresExperienceRepository,
  PostgresGeneratedArtifactRepository,
  PostgresGenerationArtifactBundleRepository,
  PostgresGenerationSessionRepository,
  PostgresGraphViewSnapshotRepository,
  PostgresJDRequirementRepository,
  PostgresSkillRepository,
} from "../src/persistence/postgres/index.js";
import type { Evidence, EvidenceChain, Experience, GeneratedArtifact, GraphView, JDRequirement, Skill } from "../src/knowledge/types.js";
import type { GenerationSession } from "../src/application/sessions/types.js";
import type { ExtractedTextDocument } from "../src/tools/document/types.js";

const shouldRun = process.env.RUN_POSTGRES_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = shouldRun ? describe : describe.skip;

describeIntegration("PostgreSQL repositories integration", () => {
  it("initializes schema and persists core JSONB records with user isolation", async () => {
    const database = new PostgresDatabase({ connectionString: process.env.DATABASE_URL });
    const userId = `pg-integration-${Date.now()}`;
    await database.initializeSchema();

    try {
      const documents = new PostgresDocumentRepository(database);
      const experiences = new PostgresExperienceRepository(database);
      const evidences = new PostgresEvidenceRepository(database);
      const skills = new PostgresSkillRepository(database);
      const requirements = new PostgresJDRequirementRepository(database);
      const artifacts = new PostgresGeneratedArtifactRepository(database);
      const sessions = new PostgresGenerationSessionRepository(database);
      const chains = new PostgresEvidenceChainSnapshotRepository(database);
      const graphs = new PostgresGraphViewSnapshotRepository(database);
      const bundles = new PostgresGenerationArtifactBundleRepository(database);

      const fixture = createFixture(userId);
      await documents.save(fixture.document);
      await experiences.save(fixture.experience);
      await evidences.save(fixture.evidence);
      await skills.save(fixture.skill);
      await requirements.save(fixture.requirement);
      await artifacts.save(fixture.artifact);
      await sessions.save(fixture.session);
      await chains.save(fixture.chainSnapshot);
      await graphs.save(fixture.graphSnapshot);
      await bundles.save(fixture.bundle);

      expect(await documents.getById(userId, fixture.document.documentId)).toMatchObject({
        documentId: fixture.document.documentId,
        metadata: fixture.document.metadata,
      });
      expect(await experiences.getByIdForUser(userId, fixture.experience.id)).toMatchObject({
        id: fixture.experience.id,
        sourceDocumentId: fixture.document.documentId,
        metadata: { sourceDocumentId: fixture.document.documentId },
      });
      expect(await evidences.getByIdForUser(userId, fixture.evidence.id)).toMatchObject({
        id: fixture.evidence.id,
        sourceDocumentId: fixture.document.documentId,
        metadata: { sourceDocumentId: fixture.document.documentId },
      });
      expect(await skills.findByName(userId, "react")).toMatchObject({ id: fixture.skill.id });
      expect(await requirements.listByJDId(userId, fixture.requirement.jdId)).toHaveLength(1);
      expect(await artifacts.getByIdForUser(userId, fixture.artifact.id)).toMatchObject({ id: fixture.artifact.id });
      expect(await sessions.getById(userId, fixture.session.id)).toMatchObject({
        id: fixture.session.id,
        generation: { jdText: "Need React." },
      });
      expect(await chains.listBySessionId(userId, fixture.session.id)).toHaveLength(1);
      expect(await graphs.listByScope(userId, "artifact", fixture.artifact.id)).toHaveLength(1);
      expect(await bundles.listBySessionId(userId, fixture.session.id)).toHaveLength(1);
      expect(await experiences.getByIdForUser("other-user", fixture.experience.id)).toBeNull();
    } finally {
      await cleanupUser(database, userId);
      await database.close();
    }
  });
});

async function cleanupUser(database: PostgresDatabase, userId: string): Promise<void> {
  for (const table of [
    "agent_runs",
    "coverage_gap_decisions",
    "artifact_decisions",
    "graph_view_snapshots",
    "evidence_chain_snapshots",
    "generation_artifact_bundles",
    "generation_sessions",
    "generated_artifacts",
    "jd_requirements",
    "jd_profiles",
    "skills",
    "evidences",
    "experiences",
    "documents",
  ]) {
    await database.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
  await database.query("DELETE FROM users WHERE id = $1", [userId]);
}

function createFixture(userId: string) {
  const now = "2024-01-01T00:00:00.000Z";
  const document: ExtractedTextDocument = {
    documentId: "doc-integration",
    userId,
    sourceType: "markdown",
    fileName: "resume.md",
    mimeType: "text/markdown",
    text: "Built React systems.",
    textPreview: "Built React systems.",
    textLength: 20,
    sourceRef: "upload:resume.md",
    metadata: { parser: "integration", source: "test" },
    createdAt: now,
  };
  const experience: Experience = {
    id: "exp-integration",
    userId,
    type: "work",
    organization: "Acme",
    role: "Frontend Engineer",
    summary: "Built React systems.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "s", task: "t", action: "a", result: "r" },
    evidenceIds: ["evidence-integration"],
    skillIds: ["skill-integration"],
    confidence: 0.9,
    sourceDocumentId: document.documentId,
    metadata: { sourceDocumentId: document.documentId },
    createdAt: now,
    updatedAt: now,
  };
  const evidence: Evidence = {
    id: "evidence-integration",
    userId,
    experienceId: experience.id,
    sourceType: "resume",
    evidenceType: "project",
    sourceRef: document.sourceRef,
    excerpt: "Built React systems.",
    confidence: 0.9,
    sourceDocumentId: document.documentId,
    metadata: { sourceDocumentId: document.documentId },
    createdAt: now,
  };
  const skill: Skill = {
    id: "skill-integration",
    userId,
    name: "React",
    category: "technical",
    evidenceIds: [evidence.id],
    createdAt: now,
    updatedAt: now,
  };
  const requirement: JDRequirement = {
    id: "req-integration",
    userId,
    jdId: "jd-integration",
    description: "React experience",
    requiredSkillIds: [skill.id],
    weight: 1,
    createdAt: now,
  };
  const artifact: GeneratedArtifact = {
    id: "artifact-integration",
    userId,
    type: "resume_bullet",
    content: "Built React systems.",
    sourceExperienceIds: [experience.id],
    sourceEvidenceIds: [evidence.id],
    matchedSkillIds: [skill.id],
    targetJDId: requirement.jdId,
    targetRequirementIds: [requirement.id],
    targetRole: "Frontend Engineer",
    scores: { overall: 0.9, requirementMatch: 0.9, evidenceStrength: 0.9 },
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  const chain: EvidenceChain = {
    id: "chain-integration",
    artifact,
    summary: "Supported.",
    requirementMatches: [],
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
    nodes: [{ id: artifact.id, type: "artifact", label: "Artifact", detail: artifact.content }],
    edges: [],
  };
  const session: GenerationSession = {
    id: "session-integration",
    userId,
    jdId: requirement.jdId,
    generation: {
      userId,
      jdId: requirement.jdId,
      jdText: "Need React.",
      targetRole: "Frontend Engineer",
      requirements: [requirement],
      retrievedExperiences: [],
      artifacts: [{ artifact, evidenceChain: chain, graphView: graph }],
      coverageReport: {
        id: "coverage-integration",
        jdId: requirement.jdId,
        userId,
        totalRequirements: 1,
        coveredRequirementIds: [requirement.id],
        weaklyCoveredRequirementIds: [],
        evidenceAvailableButNotUsedRequirementIds: [],
        noEvidenceRequirementIds: [],
        notTargetedRequirementIds: [],
        items: [],
        summary: "Covered.",
        createdAt: now,
      },
      coverageGapReport: {
        id: "gap-integration",
        userId,
        jdId: requirement.jdId,
        items: [],
        supplementalArtifactCount: 0,
        evidenceRequestCount: 0,
        summary: "No gaps.",
        createdAt: now,
      },
      critiqueReport: {
        id: "critique-integration",
        userId,
        jdId: requirement.jdId,
        items: [],
        summary: "Pass.",
        createdAt: now,
      },
      createdAt: now,
    },
    artifactDecisions: [],
    coverageGapDecisions: [],
    supplementalArtifactDrafts: [],
    status: "completed",
    createdAt: now,
    updatedAt: now,
  };

  return {
    document,
    experience,
    evidence,
    skill,
    requirement,
    artifact,
    session,
    chainSnapshot: {
      id: "chain-snapshot-integration",
      userId,
      sessionId: session.id,
      artifactId: artifact.id,
      chain,
      createdAt: now,
      updatedAt: now,
    },
    graphSnapshot: {
      id: "graph-snapshot-integration",
      userId,
      scopeType: "artifact" as const,
      scopeId: artifact.id,
      graph,
      createdAt: now,
      updatedAt: now,
    },
    bundle: {
      id: "bundle-integration",
      userId,
      sessionId: session.id,
      artifactId: artifact.id,
      evidenceChainSnapshotId: "chain-snapshot-integration",
      graphViewSnapshotId: "graph-snapshot-integration",
      decisionStatus: "undecided" as const,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
  };
}
