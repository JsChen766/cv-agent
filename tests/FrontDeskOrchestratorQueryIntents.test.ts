import { describe, expect, it } from "vitest";
import { FrontDeskAgent } from "../src/agents/FrontDeskAgent.js";
import { FrontDeskOrchestrator } from "../src/application/frontdesk/index.js";
import { EvidenceChainQueryService, GraphViewQueryService } from "../src/application/query/index.js";
import { ResumeGenerationService } from "../src/application/ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../src/application/generators/DeterministicArtifactGenerator.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../src/knowledge/index.js";
import { MockProvider } from "../src/providers/MockProvider.js";
import type {
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
  GraphViewSnapshot,
  GraphViewSnapshotRepository,
} from "../src/persistence/repositories.js";
import { DocumentLoaderTool } from "../src/tools/document/index.js";
import { createEvidenceChainSnapshot, createGraphViewSnapshot } from "./queryFixtures.js";

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

function createOrchestrator(input: {
  evidenceSnapshots?: EvidenceChainSnapshot[];
  graphSnapshots?: GraphViewSnapshot[];
}): FrontDeskOrchestrator {
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();
  const requirementRepo = new InMemoryJDRequirementRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();
  const frontDeskAgent = new FrontDeskAgent({
    modelClient: new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock",
      maxRetries: 0,
    }),
  });
  const ingestionService = new ExperienceIngestionService(experienceRepo, evidenceRepo, skillRepo);
  const resumeGenerationService = new ResumeGenerationService(
    new DeterministicJDRequirementExtractor(skillRepo, requirementRepo),
    new DeterministicArtifactGenerator(),
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    new KeywordExperienceRetriever(experienceRepo, evidenceRepo, skillRepo),
  );

  return new FrontDeskOrchestrator(
    frontDeskAgent,
    new DocumentLoaderTool(),
    ingestionService,
    resumeGenerationService,
    undefined,
    {
      evidenceChainQueryService: new EvidenceChainQueryService(
        new FakeEvidenceChainSnapshotRepository(input.evidenceSnapshots ?? []),
      ),
      graphViewQueryService: new GraphViewQueryService(
        new FakeGraphViewSnapshotRepository(input.graphSnapshots ?? []),
      ),
    },
  );
}

describe("FrontDeskOrchestrator query intents", () => {
  it("explains evidence chains by session id", async () => {
    const orchestrator = createOrchestrator({
      evidenceSnapshots: [
        createEvidenceChainSnapshot({ id: "snapshot-1", userId: "user-1", sessionId: "session-1" }),
      ],
    });

    const response = await orchestrator.handle({
      userId: "user-1",
      message: "Explain the evidence chain.",
      sessionId: "session-1",
    });

    expect(response.decision.intent).toBe("explain_evidence_chain");
    expect(response.evidenceChainSnapshots).toHaveLength(1);
    expect(response.explanation).toContain("Found 1 evidence chains");
    expect(response.warnings).toEqual([]);
  });

  it("returns a warning when evidence chain parameters are missing", async () => {
    const orchestrator = createOrchestrator({});

    const response = await orchestrator.handle({
      userId: "user-1",
      message: "Explain the evidence chain.",
    });

    expect(response.decision.intent).toBe("explain_evidence_chain");
    expect(response.warnings).toContain("Need evidenceChainSnapshotId, sessionId, or artifactId to explain evidence chain.");
  });

  it("shows experience graph by artifact id", async () => {
    const orchestrator = createOrchestrator({
      graphSnapshots: [
        createGraphViewSnapshot({ id: "graph-1", userId: "user-1", scopeType: "artifact", scopeId: "artifact-1" }),
      ],
    });

    const response = await orchestrator.handle({
      userId: "user-1",
      message: "Show the experience graph.",
      artifactId: "artifact-1",
    });

    expect(response.decision.intent).toBe("show_experience_graph");
    expect(response.graphViewSnapshots).toHaveLength(1);
    expect(response.graphExplanation).toContain("Found 1 graph views");
    expect(response.warnings).toEqual([]);
  });

  it("returns a warning when graph parameters are missing", async () => {
    const orchestrator = createOrchestrator({});

    const response = await orchestrator.handle({
      userId: "user-1",
      message: "Show the experience graph.",
    });

    expect(response.decision.intent).toBe("show_experience_graph");
    expect(response.warnings).toContain("Need graphScopeType and graphScopeId, artifactId, or sessionId to show experience graph.");
  });
});
