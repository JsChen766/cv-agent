import { createHash, randomUUID } from "node:crypto";
import { readPlatformConfig } from "../platform/config.js";
import type { FileRepository } from "./FileRepository.js";
import type { FileStorage } from "./FileStorage.js";
import { assertFileUploadEnabled, sourceTypeForMime, validateFile } from "./FileValidation.js";
import type { ParsedDocument, UploadedFile } from "./types.js";

export class FileService {
  public constructor(
    private readonly repository: FileRepository,
    private readonly storage: FileStorage,
  ) {}

  public async uploadFile(userId: string, input: { originalName: string; mimeType: string; buffer: Buffer }): Promise<UploadedFile> {
    assertFileUploadEnabled();
    validateFile({ originalName: input.originalName, mimeType: input.mimeType, sizeBytes: input.buffer.length });
    const stored = await this.storage.save(input.buffer, input.originalName);
    const now = new Date().toISOString();
    return this.repository.createFile({
      id: `file-${randomUUID()}`,
      userId,
      originalName: sanitizeName(input.originalName),
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      sha256: createHash("sha256").update(input.buffer).digest("hex"),
      status: "uploaded",
      createdAt: now,
      updatedAt: now,
    });
  }

  public listFiles(userId: string, limit?: number): Promise<UploadedFile[]> {
    return this.repository.listFiles(userId, limit);
  }

  public getFile(userId: string, id: string): Promise<UploadedFile | null> {
    return this.repository.getFile(userId, id);
  }

  public async deleteFile(userId: string, id: string): Promise<UploadedFile | null> {
    const file = await this.repository.getFile(userId, id);
    if (!file) return null;
    await this.storage.delete(file.storageKey).catch(() => undefined);
    return this.repository.updateFile(userId, id, { status: "deleted", deletedAt: new Date().toISOString() });
  }

  public async parseFile(userId: string, id: string): Promise<ParsedDocument> {
    const file = await this.repository.getFile(userId, id);
    if (!file) throw new Error("File not found.");
    try {
      await this.repository.updateFile(userId, id, { parserStatus: "running" });
      const buffer = await this.storage.read(file.storageKey);
      const extracted = extractText(file.originalName, file.mimeType, buffer);
      const maxChars = readPlatformConfig().fileMaxParsedTextChars;
      const text = extracted.text.length > maxChars ? extracted.text.slice(0, maxChars) : extracted.text;
      const document = await this.repository.createParsedDocument({
        id: `pdoc-${randomUUID()}`,
        userId,
        fileId: file.id,
        sourceType: sourceTypeForMime(file.mimeType),
        text,
        metadata: { ...extracted.metadata, truncated: extracted.text.length > maxChars, originalLength: extracted.text.length },
        createdAt: new Date().toISOString(),
      });
      await this.repository.updateFile(userId, id, { status: "parsed", parserStatus: "parsed", parserError: undefined, textDocumentId: document.id });
      return document;
    } catch (error) {
      await this.repository.updateFile(userId, id, { status: "failed", parserStatus: "failed", parserError: error instanceof Error ? error.message : "Parse failed." });
      throw error;
    }
  }

  public getParsedDocument(userId: string, id: string): Promise<ParsedDocument | null> {
    return this.repository.getParsedDocument(userId, id);
  }

  public getParsedDocumentByFileId(userId: string, fileId: string): Promise<ParsedDocument | null> {
    return this.repository.getParsedDocumentByFileId(userId, fileId);
  }
}

function extractText(fileName: string, mimeType: string, buffer: Buffer): { text: string; metadata: Record<string, unknown> } {
  return {
    text: buffer.toString("utf8"),
    metadata: {
      parser: "PlainTextFileParser",
      fileName,
      mimeType,
    },
  };
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:\0]/g, "_").slice(0, 200) || "upload";
}
