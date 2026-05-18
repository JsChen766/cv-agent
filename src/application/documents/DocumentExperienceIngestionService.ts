import type { ExperienceIngestionService } from "../../knowledge/ingestion/ExperienceIngestionService.js";
import type { DocumentInput, ExtractedTextDocument } from "../../tools/document/index.js";
import type { DocumentIngestionService } from "./DocumentIngestionService.js";
import type { IngestDocumentResult } from "../../kernel/types.js";

export class DocumentExperienceIngestionService {
  public constructor(
    private readonly documentIngestionService: DocumentIngestionService,
    private readonly experienceIngestionService: ExperienceIngestionService,
  ) {}

  public async ingest(input: {
    userId: string;
    message?: string;
    documents: DocumentInput[];
  }): Promise<IngestDocumentResult> {
    const warnings: string[] = [];
    const extractedDocuments: ExtractedTextDocument[] = [];
    const experiences: IngestDocumentResult["experiences"] = [];
    const evidences: IngestDocumentResult["evidences"] = [];
    const skills: IngestDocumentResult["skills"] = [];

    for (const documentInput of input.documents) {
      try {
        const extractedDocument = await this.documentIngestionService.ingest(documentInput);
        extractedDocuments.push(extractedDocument);
        const result = await this.experienceIngestionService.ingest({
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
        experiences.push(...result.experiences);
        evidences.push(...result.evidences);
        skills.push(...result.skills);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push(`Failed to ingest ${documentInput.fileName}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    return {
      extractedDocuments,
      experience: experiences[0],
      experiences,
      evidences,
      skills,
      warnings,
    };
  }
}
