import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { stableId } from "../../knowledge/keywordUtils.js";
import type { DocumentInput, DocumentSourceType, ExtractedTextDocument } from "./types.js";

const DEFAULT_PREVIEW_LENGTH = 500;

export function detectDocumentSourceType(input: DocumentInput): DocumentSourceType | null {
  const mimeType = input.mimeType?.toLowerCase();
  const extension = normalizeExtension(input.extension ?? extname(input.fileName));

  if (mimeType === "application/pdf" || extension === "pdf") {
    return "pdf";
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    return "docx";
  }
  if (
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown" ||
    extension === "md" ||
    extension === "markdown"
  ) {
    return "markdown";
  }
  if (mimeType?.startsWith("text/") || extension === "txt" || extension === "text") {
    return "plain_text";
  }

  return null;
}

export async function readDocumentBytes(input: DocumentInput): Promise<Uint8Array> {
  if (input.buffer) {
    return input.buffer;
  }
  if (input.filePath) {
    return readFile(input.filePath);
  }
  if (input.url) {
    throw new Error("Document URL loading is not implemented yet. Pass filePath or buffer from the API layer.");
  }
  throw new Error("Document parser requires filePath or buffer.");
}

export async function getOriginalSizeBytes(input: DocumentInput, bytes?: Uint8Array): Promise<number | undefined> {
  if (input.buffer) {
    return input.buffer.byteLength;
  }
  if (input.filePath) {
    return (await stat(input.filePath)).size;
  }
  return bytes?.byteLength;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export function buildExtractedTextDocument(input: {
  documentInput: DocumentInput;
  sourceType: DocumentSourceType;
  parser: string;
  text: string;
  title?: string;
  pageCount?: number;
  originalSizeBytes?: number;
  metadata?: Record<string, unknown>;
}): ExtractedTextDocument {
  const createdAt = new Date().toISOString();
  const text = input.text;
  const documentId = stableId("doc", [
    input.documentInput.userId,
    input.sourceType,
    input.documentInput.sourceRef,
    input.documentInput.fileName,
    text,
  ].join(":"));

  return {
    documentId,
    userId: input.documentInput.userId,
    sourceType: input.sourceType,
    fileName: input.documentInput.fileName,
    ...(input.documentInput.mimeType ? { mimeType: input.documentInput.mimeType } : {}),
    ...(input.title ? { title: input.title } : {}),
    text,
    textPreview: text.slice(0, DEFAULT_PREVIEW_LENGTH),
    textLength: text.length,
    sourceRef: input.documentInput.sourceRef,
    metadata: {
      ...input.documentInput.metadata,
      ...input.metadata,
      parser: input.parser,
      ...(input.pageCount === undefined ? {} : { pageCount: input.pageCount }),
      wordCount: countWords(text),
      ...(input.originalSizeBytes === undefined ? {} : { originalSizeBytes: input.originalSizeBytes }),
    },
    createdAt,
  };
}

function normalizeExtension(extension: string): string {
  return extension.trim().toLowerCase().replace(/^\./, "");
}

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches?.length ?? 0;
}
