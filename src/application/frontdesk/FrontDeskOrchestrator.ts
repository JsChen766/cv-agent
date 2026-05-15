import type { FrontDeskAgent } from "../../agents/FrontDeskAgent.js";
import type { DocumentIngestionService } from "../documents/DocumentIngestionService.js";
import type { ExperienceIngestionService } from "../../knowledge/ingestion/ExperienceIngestionService.js";
import type { ResumeGenerationService } from "../ResumeGenerationService.js";
import { DocumentLoaderTool } from "../../tools/document/DocumentLoaderTool.js";
import type { DocumentInput, ExtractedTextDocument } from "../../tools/document/types.js";
import type { FrontDeskRequest, FrontDeskResponse } from "./types.js";

export class FrontDeskOrchestrator {
  public constructor(
    private readonly frontDeskAgent: FrontDeskAgent,
    private readonly documentLoader: DocumentLoaderTool,
    private readonly ingestionService: ExperienceIngestionService,
    private readonly resumeGenerationService: ResumeGenerationService,
    private readonly documentIngestionService?: DocumentIngestionService,
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
      const documentInput = input.documents?.[0];
      if (!documentInput) {
        return {
          decision,
          warnings: ["FrontDeskAgent requested document ingestion, but no document input was provided."],
        };
      }
      const extractedDocument = await this.loadDocument(documentInput);
      const ingestResult = await this.ingestionService.ingest({
        userId: input.userId,
        rawText: extractedDocument.text,
        sourceRef: extractedDocument.sourceRef,
        sourceType: "resume",
        sourceDocumentId: extractedDocument.documentId,
        documentMetadata: {
          documentId: extractedDocument.documentId,
          fileName: extractedDocument.fileName,
          sourceType: extractedDocument.sourceType,
          sourceRef: extractedDocument.sourceRef,
          parser: extractedDocument.metadata.parser,
          textLength: extractedDocument.textLength,
        },
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

    if (decision.intent === "add_experience_text") {
      const documentInput = this.toPlainTextDocumentInput(input);
      const extractedDocument = await this.loadDocument(documentInput);
      const ingestResult = await this.ingestionService.ingest({
        userId: input.userId,
        rawText: extractedDocument.text,
        sourceRef: extractedDocument.sourceRef,
        sourceType: "manual",
        sourceDocumentId: extractedDocument.documentId,
        documentMetadata: {
          documentId: extractedDocument.documentId,
          fileName: extractedDocument.fileName,
          sourceType: extractedDocument.sourceType,
          sourceRef: extractedDocument.sourceRef,
          parser: extractedDocument.metadata.parser,
          textLength: extractedDocument.textLength,
        },
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
