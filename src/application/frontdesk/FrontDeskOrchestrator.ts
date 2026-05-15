import type { FrontDeskAgent } from "../../agents/FrontDeskAgent.js";
import type { DocumentIngestionService } from "../documents/DocumentIngestionService.js";
import type { ExperienceIngestionService } from "../../knowledge/ingestion/ExperienceIngestionService.js";
import type { ResumeGenerationService } from "../ResumeGenerationService.js";
import type { EvidenceChainQueryService } from "../query/EvidenceChainQueryService.js";
import type { GraphScopeType, GraphViewQueryService } from "../query/GraphViewQueryService.js";
import { DocumentLoaderTool } from "../../tools/document/DocumentLoaderTool.js";
import type { DocumentInput, ExtractedTextDocument } from "../../tools/document/types.js";
import type { DocumentIngestionResult, FrontDeskRequest, FrontDeskResponse } from "./types.js";

export type FrontDeskOrchestratorQueryServices = {
  evidenceChainQueryService?: EvidenceChainQueryService;
  graphViewQueryService?: GraphViewQueryService;
};

export class FrontDeskOrchestrator {
  public constructor(
    private readonly frontDeskAgent: FrontDeskAgent,
    private readonly documentLoader: DocumentLoaderTool,
    private readonly ingestionService: ExperienceIngestionService,
    private readonly resumeGenerationService: ResumeGenerationService,
    private readonly documentIngestionService?: DocumentIngestionService,
    private readonly queryServices: FrontDeskOrchestratorQueryServices = {},
  ) {}

  public async handle(input: FrontDeskRequest): Promise<FrontDeskResponse> {
    const warnings: string[] = [];
    const decision = await this.frontDeskAgent.decide({
      userId: input.userId,
      message: input.message,
      hasDocument: Boolean(input.documents?.length),
      documentFileNames: input.documents?.map((document) => document.fileName),
    });

    if (decision.intent === "ingest_resume_document") {
      const documentInputs = input.documents ?? [];
      if (documentInputs.length === 0) {
        return {
          decision,
          warnings: ["FrontDeskAgent requested document ingestion, but no document input was provided."],
        };
      }

      const documentIngestionResults: DocumentIngestionResult[] = [];
      for (const documentInput of documentInputs) {
        try {
          const extractedDocument = await this.loadDocument(documentInput);
          const ingestResult = await this.ingestionService.ingest({
            userId: input.userId,
            rawText: extractedDocument.text,
            sourceRef: extractedDocument.sourceRef,
            sourceType: "resume",
            sourceDocumentId: extractedDocument.documentId,
            documentMetadata: this.toDocumentMetadata(extractedDocument),
          });
          documentIngestionResults.push({
            extractedDocument,
            experience: ingestResult.experience,
            evidences: ingestResult.evidences,
            skills: ingestResult.skills,
            warnings: [],
          });
        } catch (error) {
          warnings.push(`Failed to ingest ${documentInput.fileName}: ${this.errorMessage(error)}`);
        }
      }

      const extractedDocuments = documentIngestionResults.map((result) => result.extractedDocument);
      const experiences = documentIngestionResults.flatMap((result) => (
        result.experience ? [result.experience] : []
      ));
      const evidences = documentIngestionResults.flatMap((result) => result.evidences);
      const skills = documentIngestionResults.flatMap((result) => result.skills);

      return {
        decision,
        extractedDocument: extractedDocuments[0],
        extractedDocuments,
        experience: experiences[0],
        experiences,
        evidences,
        skills,
        documentIngestionResults,
        warnings,
      };
    }

    if (decision.intent === "add_experience_text") {
      const documentInput = this.toPlainTextDocumentInput(input);
      const extractedDocument = await this.loadDocument(documentInput);
      const ingestResult = await this.ingestionService.ingest({
        userId: input.userId,
        rawText: extractedDocument.text,
        sourceRef: extractedDocument.sourceRef,
        sourceType: "manual",
        sourceDocumentId: extractedDocument.documentId,
        documentMetadata: this.toDocumentMetadata(extractedDocument),
      });
      return {
        decision,
        extractedDocument,
        experience: ingestResult.experience,
        evidences: ingestResult.evidences,
        skills: ingestResult.skills,
        warnings,
      };
    }

    if (decision.intent === "generate_resume_for_jd") {
      const jdText = input.jdText ?? this.extractStringArgument(decision, "jdText") ?? input.message;
      const targetRole = input.targetRole ?? this.extractStringArgument(decision, "targetRole") ?? "Frontend Engineer";
      const generationResult = await this.resumeGenerationService.generate({
        userId: input.userId,
        jdText,
        targetRole,
      });
      return {
        decision,
        artifacts: generationResult.artifacts,
        evidenceChains: generationResult.evidenceChains,
        graphViews: generationResult.graphViews,
        coverageReport: generationResult.coverageReport,
        coverageGapReport: generationResult.coverageGapReport,
        critiqueReport: generationResult.critiqueReport,
        warnings,
      };
    }

    if (decision.intent === "explain_evidence_chain") {
      const service = this.queryServices.evidenceChainQueryService;
      if (!service) {
        return {
          decision,
          warnings: ["Evidence chain query service is not configured."],
        };
      }
      if (input.evidenceChainSnapshotId) {
        const result = await service.getBySnapshotId(input.userId, input.evidenceChainSnapshotId);
        return {
          decision,
          evidenceChainSnapshots: result.evidenceChains,
          explanation: result.summary,
          warnings,
        };
      }
      if (input.sessionId) {
        const result = await service.listBySessionId(input.userId, input.sessionId);
        return {
          decision,
          evidenceChainSnapshots: result.evidenceChains,
          explanation: result.summary,
          warnings,
        };
      }
      if (input.artifactId) {
        const result = await service.listByArtifactId(input.userId, input.artifactId);
        return {
          decision,
          evidenceChainSnapshots: result.evidenceChains,
          explanation: result.summary,
          warnings,
        };
      }
      return {
        decision,
        warnings: ["Need evidenceChainSnapshotId, sessionId, or artifactId to explain evidence chain."],
      };
    }

    if (decision.intent === "show_experience_graph") {
      const service = this.queryServices.graphViewQueryService;
      if (!service) {
        return {
          decision,
          warnings: ["Graph view query service is not configured."],
        };
      }

      const scope = this.resolveGraphScope(input);
      if (!scope) {
        return {
          decision,
          warnings: ["Need graphScopeType and graphScopeId, artifactId, or sessionId to show experience graph."],
        };
      }

      const result = await service.listByScope(input.userId, scope.scopeType, scope.scopeId);
      return {
        decision,
        graphViewSnapshots: result.graphViews,
        graphExplanation: result.summary,
        warnings: [...warnings, ...result.warnings],
      };
    }

    warnings.push(`FrontDesk intent "${decision.intent}" is recognized but not executable in kernel v0.2.`);
    return { decision, warnings };
  }

  private toPlainTextDocumentInput(input: FrontDeskRequest): DocumentInput {
    return {
      userId: input.userId,
      fileName: "chat-experience.txt",
      mimeType: "text/plain",
      extension: "txt",
      sourceRef: `chat:${input.userId}:${new Date().toISOString()}`,
      buffer: new TextEncoder().encode(input.message),
      metadata: {
        source: "chat",
      },
    };
  }

  private async loadDocument(input: DocumentInput): Promise<ExtractedTextDocument> {
    return this.documentIngestionService
      ? this.documentIngestionService.ingest(input)
      : this.documentLoader.load(input);
  }

  private toDocumentMetadata(extractedDocument: ExtractedTextDocument): {
    documentId: string;
    fileName: string;
    sourceType: string;
    sourceRef: string;
    parser: string;
    textLength: number;
  } {
    return {
      documentId: extractedDocument.documentId,
      fileName: extractedDocument.fileName,
      sourceType: extractedDocument.sourceType,
      sourceRef: extractedDocument.sourceRef,
      parser: extractedDocument.metadata.parser,
      textLength: extractedDocument.textLength,
    };
  }

  private resolveGraphScope(input: FrontDeskRequest): { scopeType: GraphScopeType; scopeId: string } | null {
    if (input.graphScopeType && input.graphScopeId) {
      return {
        scopeType: input.graphScopeType,
        scopeId: input.graphScopeId,
      };
    }
    if (input.artifactId) {
      return {
        scopeType: "artifact",
        scopeId: input.artifactId,
      };
    }
    if (input.sessionId) {
      return {
        scopeType: "generation",
        scopeId: input.sessionId,
      };
    }
    return null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private extractStringArgument(
    decision: FrontDeskResponse["decision"],
    name: string,
  ): string | undefined {
    for (const action of decision.requiredActions) {
      const value = action.arguments?.[name];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return undefined;
  }
}
