import { describe, expect, it } from "vitest";
import { DocumentIngestionService } from "../src/application/documents/index.js";
import { DocumentLoaderTool } from "../src/tools/document/DocumentLoaderTool.js";
import type { DocumentInput, ExtractedTextDocument } from "../src/tools/document/types.js";
import type { DocumentRepository, PersistedDocument } from "../src/persistence/repositories.js";

class FakeDocumentLoader extends DocumentLoaderTool {
  public loadCount = 0;

  public constructor(private readonly document: ExtractedTextDocument) {
    super();
  }

  public override async load(_input: DocumentInput): Promise<ExtractedTextDocument> {
    this.loadCount += 1;
    return this.document;
  }
}

class FakeDocumentRepository implements DocumentRepository {
  public saved: Array<ExtractedTextDocument | PersistedDocument> = [];

  public async save(document: ExtractedTextDocument | PersistedDocument): Promise<void> {
    this.saved.push(document);
  }

  public async getById(_userId: string, _id: string): Promise<PersistedDocument | null> {
    return null;
  }

  public async listByUserId(_userId: string): Promise<PersistedDocument[]> {
    return [];
  }

  public async delete(_userId: string, _id: string): Promise<void> {}
}

describe("DocumentIngestionService", () => {
  it("parses through DocumentLoaderTool and saves the extracted document", async () => {
    const document: ExtractedTextDocument = {
      documentId: "doc-1",
      userId: "user-1",
      sourceType: "markdown",
      fileName: "resume.md",
      text: "Built React systems.",
      textPreview: "Built React systems.",
      textLength: 20,
      sourceRef: "upload:resume.md",
      metadata: { parser: "markdown" },
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const loader = new FakeDocumentLoader(document);
    const repository = new FakeDocumentRepository();
    const service = new DocumentIngestionService(loader, repository);

    const result = await service.ingest({
      userId: "user-1",
      fileName: "resume.md",
      sourceRef: "upload:resume.md",
      buffer: new TextEncoder().encode("# Resume"),
    });

    expect(result).toBe(document);
    expect(loader.loadCount).toBe(1);
    expect(repository.saved).toEqual([document]);
  });
});
