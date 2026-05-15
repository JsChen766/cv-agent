import type { GenerateResumeResponse } from "../../api-contracts/generation.js";
import type { GenerateResumeResult } from "../ResumeGenerationService.js";
import type { GenerationSession } from "../sessions/types.js";
import { stableId } from "../../knowledge/keywordUtils.js";
import type {
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
  GenerationArtifactBundleRecord,
  GenerationArtifactBundleRepository,
  GenerationPersistenceResult,
  GraphViewSnapshot,
  GraphViewSnapshotRepository,
  PersistedGenerationSessionRepository,
} from "../../persistence/repositories.js";

export class GenerationPersistenceService {
  public constructor(
    private readonly sessionRepository: PersistedGenerationSessionRepository,
    private readonly evidenceChainSnapshotRepository: EvidenceChainSnapshotRepository,
    private readonly graphViewSnapshotRepository: GraphViewSnapshotRepository,
    private readonly bundleRepository: GenerationArtifactBundleRepository,
  ) {}

  public async persist(
    result: GenerateResumeResult,
    metadata: Record<string, unknown> = {},
  ): Promise<GenerationPersistenceResult> {
    const now = new Date().toISOString();
    const sessionId = stableId("generation-session", `${result.userId}:${result.jdId}:${result.createdAt}`);
    const session: GenerationSession = {
      id: sessionId,
      userId: result.userId,
      jdId: result.jdId,
      generation: toGenerationResponse(result),
      artifactDecisions: [],
      coverageGapDecisions: [],
      supplementalArtifactDrafts: [],
      status: "completed",
      createdAt: now,
      updatedAt: now,
    };

    const evidenceChainSnapshots: EvidenceChainSnapshot[] = result.evidenceChains.map((chain) => ({
      id: stableId("evidence-chain-snapshot", `${sessionId}:${chain.id}`),
      userId: result.userId,
      sessionId,
      artifactId: chain.artifact.id,
      chain,
      createdAt: now,
      updatedAt: now,
    }));

    const graphViewSnapshots: GraphViewSnapshot[] = result.graphViews.map((graph, index) => {
      const artifact = result.artifacts[index];
      const scopeId = artifact?.id ?? sessionId;
      return {
        id: stableId("graph-view-snapshot", `${sessionId}:${scopeId}:${index}`),
        userId: result.userId,
        scopeType: artifact ? "artifact" : "generation",
        scopeId,
        graph,
        createdAt: now,
        updatedAt: now,
      };
    });

    const bundles: GenerationArtifactBundleRecord[] = result.artifacts.map((artifact, index) => ({
      id: stableId("generation-bundle", `${sessionId}:${artifact.id}`),
      userId: result.userId,
      sessionId,
      artifactId: artifact.id,
      evidenceChainSnapshotId: evidenceChainSnapshots[index]?.id,
      graphViewSnapshotId: graphViewSnapshots[index]?.id,
      decisionStatus: "undecided",
      metadata,
      createdAt: now,
      updatedAt: now,
    }));

    await this.sessionRepository.save(session);
    for (const snapshot of evidenceChainSnapshots) {
      await this.evidenceChainSnapshotRepository.save(snapshot);
    }
    for (const snapshot of graphViewSnapshots) {
      await this.graphViewSnapshotRepository.save(snapshot);
    }
    for (const bundle of bundles) {
      await this.bundleRepository.save(bundle);
    }

    return {
      session,
      evidenceChainSnapshots,
      graphViewSnapshots,
      bundles,
    };
  }
}

function toGenerationResponse(result: GenerateResumeResult): GenerateResumeResponse {
  return {
    userId: result.userId,
    jdId: result.jdId,
    jdText: result.jdText,
    targetRole: result.targetRole,
    requirements: result.requirements,
    retrievedExperiences: result.retrievedExperiences,
    artifacts: result.artifacts.map((artifact, index) => ({
      artifact,
      evidenceChain: result.evidenceChains[index],
      graphView: result.graphViews[index],
    })).filter((bundle) => bundle.evidenceChain && bundle.graphView),
    coverageReport: result.coverageReport,
    coverageGapReport: result.coverageGapReport,
    critiqueReport: result.critiqueReport,
    createdAt: result.createdAt,
  };
}
