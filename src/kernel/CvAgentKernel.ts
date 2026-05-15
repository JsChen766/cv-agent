import type { FrontDeskOrchestrator } from "../application/frontdesk/index.js";
import type {
  GenerateResumeResult,
  ResumeGenerationService,
} from "../application/ResumeGenerationService.js";
import type {
  ArtifactRevisionResult,
  ArtifactRevisionService,
} from "../application/revision/index.js";
import type {
  EvidenceChainQueryResult,
  EvidenceChainQueryService,
  GraphViewQueryResult,
  GraphViewQueryService,
} from "../application/query/index.js";
import type { GenerationPersistenceResult } from "../persistence/repositories.js";
import type { KernelRequestContext } from "./context.js";
import type {
  CreateGenerationInput,
  CreateGenerationResult,
  CvAgentKernel,
  EvidenceChainQuery,
  GraphQuery,
  IngestDocumentInput,
  IngestDocumentResult,
  KernelHealth,
  KernelMode,
  ReviseArtifactInput,
} from "./types.js";

export type KernelGenerationPersistencePort = {
  persist(
    result: GenerateResumeResult,
    metadata?: Record<string, unknown>,
  ): Promise<GenerationPersistenceResult>;
};

export type DefaultCvAgentKernelInput = {
  mode: KernelMode;
  warnings: string[];
  frontDeskOrchestrator: FrontDeskOrchestrator;
  resumeGenerationService: ResumeGenerationService;
  generationPersistenceService?: KernelGenerationPersistencePort;
  evidenceChainQueryService: EvidenceChainQueryService;
  graphViewQueryService: GraphViewQueryService;
  artifactRevisionService?: ArtifactRevisionService;
  close(): Promise<void>;
};

export class DefaultCvAgentKernel implements CvAgentKernel {
  public readonly mode: KernelMode;

  public readonly documents: CvAgentKernel["documents"] = {
    ingest: (ctx, input) => this.ingestDocuments(ctx, input),
  };

  public readonly generations: CvAgentKernel["generations"] = {
    create: (ctx, input) => this.createGeneration(ctx, input),
    getEvidenceChains: (ctx, query) => this.getEvidenceChains(ctx, query),
    getGraph: (ctx, query) => this.getGraph(ctx, query),
    reviseArtifact: (ctx, input) => this.reviseArtifact(ctx, input),
  };

  private readonly warnings: string[];
  private readonly frontDeskOrchestrator: FrontDeskOrchestrator;
  private readonly resumeGenerationService: ResumeGenerationService;
  private readonly generationPersistenceService?: KernelGenerationPersistencePort;
  private readonly evidenceChainQueryService: EvidenceChainQueryService;
  private readonly graphViewQueryService: GraphViewQueryService;
  private readonly artifactRevisionService?: ArtifactRevisionService;
  private readonly closeKernel: () => Promise<void>;

  public constructor(input: DefaultCvAgentKernelInput) {
    this.mode = input.mode;
    this.warnings = input.warnings;
    this.frontDeskOrchestrator = input.frontDeskOrchestrator;
    this.resumeGenerationService = input.resumeGenerationService;
    this.generationPersistenceService = input.generationPersistenceService;
    this.evidenceChainQueryService = input.evidenceChainQueryService;
    this.graphViewQueryService = input.graphViewQueryService;
    this.artifactRevisionService = input.artifactRevisionService;
    this.closeKernel = input.close;
  }

  public async health(): Promise<KernelHealth> {
    return {
      ok: true,
      mode: this.mode,
      warnings: this.warnings,
    };
  }

  public async close(): Promise<void> {
    await this.closeKernel();
  }

  private async ingestDocuments(
    ctx: KernelRequestContext,
    input: IngestDocumentInput,
  ): Promise<IngestDocumentResult> {
    // API command path: reuse FrontDeskOrchestrator for now while keeping the facade stable.
    // TODO: split this into a direct DocumentIngestionService + ExperienceIngestionService
    // command pipeline. Full FrontDeskAgent intent handling should remain the chat path.
    const response = await this.frontDeskOrchestrator.handle({
      userId: ctx.user.id,
      message: input.message ?? "Import these resume documents.",
      documents: input.documents,
    });

    return {
      extractedDocuments: response.extractedDocuments ?? [],
      experience: response.experience,
      experiences: response.experiences ?? [],
      evidences: response.evidences ?? [],
      skills: response.skills ?? [],
      warnings: response.warnings,
    };
  }

  private async createGeneration(
    ctx: KernelRequestContext,
    input: CreateGenerationInput,
  ): Promise<CreateGenerationResult> {
    const generation = await this.resumeGenerationService.generate({
      userId: ctx.user.id,
      jdText: input.jdText,
      targetRole: input.targetRole,
    });
    const persisted = this.generationPersistenceService
      ? await this.generationPersistenceService.persist(generation, {
          source: ctx.request.source,
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
        })
      : undefined;

    return {
      artifacts: generation.artifacts,
      evidenceChains: generation.evidenceChains,
      graphViews: generation.graphViews,
      coverageReport: generation.coverageReport,
      coverageGapReport: generation.coverageGapReport,
      critiqueReport: generation.critiqueReport,
      ...(persisted
        ? {
            persistedGeneration: {
              sessionId: persisted.session.id,
              evidenceChainSnapshotCount: persisted.evidenceChainSnapshots.length,
              graphViewSnapshotCount: persisted.graphViewSnapshots.length,
              bundleCount: persisted.bundles.length,
            },
          }
        : {}),
    };
  }

  private async getEvidenceChains(
    ctx: KernelRequestContext,
    query: EvidenceChainQuery,
  ): Promise<EvidenceChainQueryResult> {
    if (query.snapshotId) {
      return this.evidenceChainQueryService.getBySnapshotId(ctx.user.id, query.snapshotId);
    }
    if (query.sessionId) {
      return this.evidenceChainQueryService.listBySessionId(ctx.user.id, query.sessionId);
    }
    if (query.artifactId) {
      return this.evidenceChainQueryService.listByArtifactId(ctx.user.id, query.artifactId);
    }
    return {
      evidenceChains: [],
      summary: "Found 0 evidence chains. Provide snapshotId, sessionId, or artifactId to query evidence chains.",
    };
  }

  private async getGraph(
    ctx: KernelRequestContext,
    query: GraphQuery,
  ): Promise<GraphViewQueryResult> {
    return this.graphViewQueryService.listByScope(ctx.user.id, query.scopeType, query.scopeId);
  }

  private async reviseArtifact(
    ctx: KernelRequestContext,
    input: ReviseArtifactInput,
  ): Promise<ArtifactRevisionResult> {
    if (!this.artifactRevisionService) {
      throw new Error("ArtifactRevisionService is not configured.");
    }
    return this.artifactRevisionService.revise({
      userId: ctx.user.id,
      jdId: input.artifact.targetJDId,
      artifact: input.artifact,
      critiqueItem: input.critiqueItem,
      evidenceChain: input.evidenceChain,
      instruction: input.instruction,
      customInstruction: input.customInstruction,
      targetRequirementIds: input.targetRequirementIds,
      userConfirmations: input.userConfirmations,
      tone: input.tone,
    });
  }
}
