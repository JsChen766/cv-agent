import type { FileRepository } from "./FileRepository.js";
import type { ParsedDocument, UploadedFile } from "./types.js";

export class InMemoryFileRepository implements FileRepository {
  private readonly files = new Map<string, UploadedFile>();
  private readonly documents = new Map<string, ParsedDocument>();

  public async createFile(file: UploadedFile): Promise<UploadedFile> {
    this.files.set(file.id, file);
    return file;
  }

  public async getFile(userId: string, id: string): Promise<UploadedFile | null> {
    const file = this.files.get(id);
    return file?.userId === userId && file.status !== "deleted" ? file : null;
  }

  public async listFiles(userId: string, limit = 50): Promise<UploadedFile[]> {
    return Array.from(this.files.values())
      .filter((file) => file.userId === userId && file.status !== "deleted")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public async updateFile(userId: string, id: string, patch: Partial<UploadedFile>): Promise<UploadedFile | null> {
    const file = await this.getFile(userId, id);
    if (!file) return null;
    const next = { ...file, ...patch, updatedAt: new Date().toISOString() };
    this.files.set(id, next);
    return next;
  }

  public async createParsedDocument(document: ParsedDocument): Promise<ParsedDocument> {
    this.documents.set(document.id, document);
    return document;
  }

  public async getParsedDocument(userId: string, id: string): Promise<ParsedDocument | null> {
    const document = this.documents.get(id);
    return document?.userId === userId ? document : null;
  }

  public async getParsedDocumentByFileId(userId: string, fileId: string): Promise<ParsedDocument | null> {
    return Array.from(this.documents.values()).find((document) => document.userId === userId && document.fileId === fileId) ?? null;
  }
}
