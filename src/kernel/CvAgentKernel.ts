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
import type { ArtifactCritiqueItem } from "../application/critique/types.js";
import type {
  ArtifactDecisionRecord,
  ArtifactDecisionService,
} from "../application/decisions/index.js";
import type { GenerationPersistenceResult } from "../persistence/repositories.js";
import type { KernelRequestContext } from "./context.js";
import {
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentStarted,
  emitKernelCompleted,
  emitKernelFailed,
  emitKernelStarted,
  emitToolCompleted,
  emitToolStarted,
} from "./events/index.js";
import type { AgentEvent } from "./events/index.js";
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
  ListArtifactDecisionsQuery,
  RecordArtifactDecisionInput,
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
  artifactDecisionService?: ArtifactDecisionService;
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
    recordArtifactDecision: (ctx, input) => this.recordArtifactDecision(ctx, input),
    listArtifactDecisions: (ctx, query) => this.listArtifactDecisions(ctx, query),
  };

  private readonly warnings: string[];
  private readonly frontDeskOrchestrator: FrontDeskOrchestrator;
  private readonly resumeGenerationService: ResumeGenerationService;
  private readonly generationPersistenceService?: KernelGenerationPersistencePort;
  private readonly evidenceChainQueryService: EvidenceChainQueryService;
  private readonly graphViewQueryService: GraphViewQueryService;
  private readonly artifactRevisionService?: ArtifactRevisionService;
  private readonly artifactDecisionService?: ArtifactDecisionService;
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
    this.artifactDecisionService = input.artifactDecisionService;
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
    await emitKernelStarted(ctx.events, {
      ...this.eventBase(ctx),
      step: "documents.ingest",
      message: "Starting document ingestion.",
      data: { documentCount: input.documents.length },
    });
    await emitToolStarted(ctx.events, {
      ...this.eventBase(ctx),
      toolName: "DocumentLoaderTool",
      step: "documents.load",
      message: "Loading document(s).",
      data: { documentCount: input.documents.length },
    });
    await emitAgentStarted(ctx.events, {
      ...this.eventBase(ctx),
      agentName: "ArchivistAgent",
      step: "experiences.extract",
      message: "ArchivistAgent extracting experiences.",
    });

    try {
      // API command path: reuse FrontDeskOrchestrator for now while keeping the facade stable.
      // TODO: split this into a direct DocumentIngestionService + ExperienceIngestionService
      // command pipeline. Full FrontDeskAgent intent handling should remain the chat path.
      const response = await this.frontDeskOrchestrator.handle({
        userId: ctx.user.id,
        message: input.message ?? "Import these resume documents.",
        documents: input.documents,
      });

      await emitToolCompleted(ctx.events, {
        ...this.eventBase(ctx),
        toolName: "DocumentLoaderTool",
        step: "documents.load",
        message: "Document loading completed.",
        data: { extractedDocumentCount: response.extractedDocuments?.length ?? 0 },
      });
      await emitAgentCompleted(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "ArchivistAgent",
        step: "experiences.extract",
        message: "ArchivistAgent extraction completed.",
        data: {
          experienceCount: response.experiences?.length ?? (response.experience ? 1 : 0),
          evidenceCount: response.evidences?.length ?? 0,
          skillCount: response.skills?.length ?? 0,
        },
      });
      await emitKernelCompleted(ctx.events, {
        ...this.eventBase(ctx),
        step: "documents.ingest",
        message: "Document ingestion completed.",
      });

      return {
        extractedDocuments: response.extractedDocuments ?? [],
        experience: response.experience,
        experiences: response.experiences ?? [],
        evidences: response.evidences ?? [],
        skills: response.skills ?? [],
        warnings: response.warnings,
      };
    } catch (error) {
      await emitAgentFailed(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "ArchivistAgent",
        step: "experiences.extract",
        message: "ArchivistAgent extraction failed.",
        data: { errorType: errorName(error) },
      });
      await emitKernelFailed(ctx.events, {
        ...this.eventBase(ctx),
        step: "documents.ingest",
        message: "Document ingestion failed.",
        data: { errorType: errorName(error) },
      });
      throw error;
    }
  }

  private async createGeneration(
    ctx: KernelRequestContext,
    input: CreateGenerationInput,
  ): Promise<CreateGenerationResult> {
    await emitKernelStarted(ctx.events, {
      ...this.eventBase(ctx),
      step: "generations.create",
      message: "Starting resume generation.",
      data: { targetRole: input.targetRole },
    });
    await emitAgentStarted(ctx.events, {
      ...this.eventBase(ctx),
      agentName: "RequirementExtractor",
      step: "requirements.extract",
      message: "Extracting job requirements.",
    });
    await emitAgentStarted(ctx.events, {
      ...this.eventBase(ctx),
      agentName: "ArtifactGenerator",
      step: "artifacts.generate",
      message: "Generating artifact candidates.",
    });
    await emitAgentStarted(ctx.events, {
      ...this.eventBase(ctx),
      agentName: "CriticAgent",
      step: "artifacts.critique",
      message: "CriticAgent reviewing generated artifacts.",
    });

    try {
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
      const result: CreateGenerationResult = {
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

      await emitAgentCompleted(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "RequirementExtractor",
        step: "requirements.extract",
        message: "Job requirement extraction completed.",
        data: { requirementCount: generation.requirements.length },
      });
      await emitAgentCompleted(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "ArtifactGenerator",
        step: "artifacts.generate",
        message: "Artifact generation completed.",
        data: { artifactCount: generation.artifacts.length },
      });
      await ctx.events?.emit({
        ...this.eventBase(ctx),
        type: "artifact.candidate.created",
        status: "completed",
        step: "artifacts.generate",
        message: "Artifact candidates created.",
        data: {
          artifactCount: generation.artifacts.length,
          artifactIds: generation.artifacts.map((artifact) => artifact.id),
        },
      });
      await emitAgentCompleted(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "CriticAgent",
        step: "artifacts.critique",
        message: "CriticAgent review completed.",
        data: this.critiqueCounts(generation.critiqueReport.items),
      });
      await ctx.events?.emit({
        ...this.eventBase(ctx),
        type: "artifact.critique.completed",
        status: "completed",
        agentName: "CriticAgent",
        step: "artifacts.critique",
        message: "Artifact critique completed.",
        data: this.critiqueCounts(generation.critiqueReport.items),
      });
      const decisionSummary = decisionRequiredSummary(generation.artifacts);
      if (decisionSummary.needsConfirmationCount > 0 || decisionSummary.unsafeCount > 0) {
        await ctx.events?.emit({
          ...this.eventBase(ctx),
          type: "decision.required",
          step: "artifacts.review",
          message: "Some generated artifacts require user review.",
          data: decisionSummary,
        });
      }
      await emitKernelCompleted(ctx.events, {
        ...this.eventBase(ctx),
        step: "generations.create",
        message: "Resume generation completed.",
        data: { artifactCount: generation.artifacts.length },
      });

      return result;
    } catch (error) {
      await emitAgentFailed(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "ResumeGenerationService",
        step: "generations.create",
        message: "Resume generation agent pipeline failed.",
        data: { errorType: errorName(error) },
      });
      await emitKernelFailed(ctx.events, {
        ...this.eventBase(ctx),
        step: "generations.create",
        message: "Resume generation failed.",
        data: { errorType: errorName(error) },
      });
      throw error;
    }
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
    await emitKernelStarted(ctx.events, {
      ...this.eventBase(ctx),
      step: "generations.reviseArtifact",
      message: "Starting artifact revision.",
      data: { artifactId: input.artifact.id, instruction: input.instruction },
    });
    await emitAgentStarted(ctx.events, {
      ...this.eventBase(ctx),
      agentName: "RevisionAgent",
      step: "artifacts.revise",
      message: "RevisionAgent revising artifact.",
      data: { artifactId: input.artifact.id },
    });

    try {
      const result = await this.artifactRevisionService.revise({
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
      await emitAgentCompleted(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "RevisionAgent",
        step: "artifacts.revise",
        message: "RevisionAgent revision completed.",
        data: { revisedArtifactId: result.revisedArtifact.id },
      });
      await ctx.events?.emit({
        ...this.eventBase(ctx),
        type: "artifact.revision.completed",
        status: "completed",
        agentName: "RevisionAgent",
        step: "artifacts.revise",
        message: "Artifact revision completed.",
        data: {
          artifactId: input.artifact.id,
          revisedArtifactId: result.revisedArtifact.id,
        },
      });
      if (readEnhancementStatus(result.revisedArtifact) === "needs_confirmation") {
        await ctx.events?.emit({
          ...this.eventBase(ctx),
          type: "decision.required",
          step: "artifacts.review",
          message: "Revised artifact requires user confirmation.",
          data: { artifactId: result.revisedArtifact.id, reason: "needs_confirmation" },
        });
      }
      await emitKernelCompleted(ctx.events, {
        ...this.eventBase(ctx),
        step: "generations.reviseArtifact",
        message: "Artifact revision completed.",
      });
      return result;
    } catch (error) {
      await emitAgentFailed(ctx.events, {
        ...this.eventBase(ctx),
        agentName: "RevisionAgent",
        step: "artifacts.revise",
        message: "RevisionAgent revision failed.",
        data: { errorType: errorName(error) },
      });
      await emitKernelFailed(ctx.events, {
        ...this.eventBase(ctx),
        step: "generations.reviseArtifact",
        message: "Artifact revision failed.",
        data: { errorType: errorName(error) },
      });
      throw error;
    }
  }

  private async recordArtifactDecision(
    ctx: KernelRequestContext,
    input: RecordArtifactDecisionInput,
  ): Promise<ArtifactDecisionRecord> {
    if (!this.artifactDecisionService) {
      throw new Error("ArtifactDecisionService is not configured.");
    }
    const record = await this.artifactDecisionService.record({
      ...input,
      userId: ctx.user.id,
    });
    return record;
  }

  private async listArtifactDecisions(
    ctx: KernelRequestContext,
    query: ListArtifactDecisionsQuery,
  ): Promise<ArtifactDecisionRecord[]> {
    if (!this.artifactDecisionService) {
      throw new Error("ArtifactDecisionService is not configured.");
    }
    if (query.artifactId) {
      return this.artifactDecisionService.listByArtifactId(ctx.user.id, query.artifactId);
    }
    if (query.sessionId) {
      return this.artifactDecisionService.listBySessionId(ctx.user.id, query.sessionId);
    }
    return [];
  }

  private eventBase(ctx: KernelRequestContext): Pick<AgentEvent, "requestId" | "traceId"> {
    return {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
    };
  }

  private critiqueCounts(items: ArtifactCritiqueItem[]): Record<string, unknown> {
    return {
      passCount: items.filter((item) => item.verdict === "pass").length,
      reviseCount: items.filter((item) => item.verdict === "revise").length,
      rejectCount: items.filter((item) => item.verdict === "reject").length,
    };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function decisionRequiredSummary(artifacts: CreateGenerationResult["artifacts"]): Record<string, unknown> & {
  needsConfirmationCount: number;
  unsafeCount: number;
} {
  const needsConfirmationArtifactIds: string[] = [];
  const unsafeArtifactIds: string[] = [];
  for (const artifact of artifacts) {
    const status = readEnhancementStatus(artifact);
    if (status === "needs_confirmation") {
      needsConfirmationArtifactIds.push(artifact.id);
    }
    if (status === "unsafe") {
      unsafeArtifactIds.push(artifact.id);
    }
  }
  return {
    needsConfirmationCount: needsConfirmationArtifactIds.length,
    unsafeCount: unsafeArtifactIds.length,
    needsConfirmationArtifactIds,
    unsafeArtifactIds,
  };
}

function readEnhancementStatus(artifact: CreateGenerationResult["artifacts"][number]): string | undefined {
  const enhancement = artifact.metadata?.enhancement;
  if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
    return undefined;
  }
  const status = (enhancement as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}
