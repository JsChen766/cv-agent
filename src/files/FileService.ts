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
      const extracted = await extractText(file.originalName, file.mimeType, buffer);
      const maxChars = readPlatformConfig().fileMaxParsedTextChars;
      const cleanedText = cleanParsedText(extracted.text);
      const text = cleanedText.length > maxChars ? cleanedText.slice(0, maxChars) : cleanedText;
      const document = await this.repository.createParsedDocument({
        id: `pdoc-${randomUUID()}`,
        userId,
        fileId: file.id,
        sourceType: sourceTypeForMime(file.mimeType),
        text,
        metadata: { ...extracted.metadata, truncated: cleanedText.length > maxChars, originalLength: cleanedText.length },
        createdAt: new Date().toISOString(),
      });
      console.debug("[files] parsed document", {
        fileId: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        pageCount: extracted.metadata.pageCount,
        textLength: text.length,
        originalLength: cleanedText.length,
        parsedDocumentId: document.id,
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

  public async getRawBuffer(userId: string, fileId: string): Promise<Buffer> {
    const file = await this.repository.getFile(userId, fileId);
    if (!file) throw new Error("File not found.");
    return this.storage.read(file.storageKey);
  }
}

function cleanParsedText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractText(fileName: string, mimeType: string, buffer: Buffer): Promise<{ text: string; metadata: Record<string, unknown> }> {
  if (mimeType === "application/pdf") {
    return extractPdfText(buffer, fileName);
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractDocxText(buffer, fileName);
  }
  // Plain text and fallback
  return {
    text: buffer.toString("utf8"),
    metadata: {
      parser: "PlainTextFileParser",
      fileName,
      mimeType,
    },
  };
}

async function extractPdfText(buffer: Buffer, fileName: string): Promise<{ text: string; metadata: Record<string, unknown> }> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.js");
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 50); i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? (item as { str: string }).str : ""))
        .join(" ");
      pages.push(pageText);
    }
    return {
      text: pages.join("\n\n"),
      metadata: {
        parser: "PdfJsParser",
        fileName,
        mimeType: "application/pdf",
        pageCount: doc.numPages,
      },
    };
  } catch (error) {
    return {
      text: `PDF parsing failed: ${error instanceof Error ? error.message : "Unknown error"}. Please try a text-based file.`,
      metadata: {
        parser: "PdfJsParser",
        fileName,
        mimeType: "application/pdf",
        error: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

async function extractDocxText(buffer: Buffer, fileName: string): Promise<{ text: string; metadata: Record<string, unknown> }> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value,
      metadata: {
        parser: "MammothParser",
        fileName,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        warnings: result.messages,
      },
    };
  } catch (error) {
    return {
      text: `DOCX parsing failed: ${error instanceof Error ? error.message : "Unknown error"}. Please try a text-based file.`,
      metadata: {
        parser: "MammothParser",
        fileName,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        error: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:\0]/g, "_").slice(0, 200) || "upload";
}
