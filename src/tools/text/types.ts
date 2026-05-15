import { stableId } from "../../knowledge/keywordUtils.js";

export type ExtractedTextSourceType =
  | "manual_text"
  | "markdown"
  | "pdf_text"
  | "docx_text"
  | "github_text";

export type ExtractedTextDocument = {
  documentId: string;
  sourceType: ExtractedTextSourceType;
  title?: string;
  text: string;
  textPreview: string;
  textLength: number;
  sourceRef: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type BuildExtractedTextDocumentInput = {
  documentId?: string;
  sourceType: ExtractedTextSourceType;
  title?: string;
  text: string;
  sourceRef: string;
  metadata?: Record<string, unknown>;
  previewLength?: number;
};

const DEFAULT_PREVIEW_LENGTH = 500;

export function buildExtractedTextDocument(
  input: BuildExtractedTextDocumentInput
): ExtractedTextDocument {
  const createdAt = new Date().toISOString();
  const documentId = input.documentId ?? stableId("text-doc", `${input.sourceType}:${input.sourceRef}:${createdAt}:${input.text}`);
  const previewLength = input.previewLength ?? DEFAULT_PREVIEW_LENGTH;

  return {
    documentId,
    sourceType: input.sourceType,
    ...(input.title === undefined ? {} : { title: input.title }),
    text: input.text,
    textPreview: input.text.slice(0, previewLength),
    textLength: input.text.length,
    sourceRef: input.sourceRef,
    metadata: input.metadata ?? {},
    createdAt
  };
}
