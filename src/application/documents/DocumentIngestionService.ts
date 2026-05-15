import { DocumentLoaderTool } from "../../tools/document/DocumentLoaderTool.js";
import type { DocumentInput, ExtractedTextDocument } from "../../tools/document/types.js";
import type { DocumentRepository } from "../../persistence/repositories.js";

export class DocumentIngestionService {
  public constructor(
    private readonly documentLoader: DocumentLoaderTool,
    private readonly documentRepository: DocumentRepository,
  ) {}

  public async ingest(input: DocumentInput): Promise<ExtractedTextDocument> {
    const extractedDocument = await this.documentLoader.load(input);
    await this.documentRepository.save(extractedDocument);
    return extractedDocument;
  }
}
