import type { DocumentInput, DocumentParser, DocumentParserInput, ExtractedTextDocument } from "./types.js";
import {
  buildExtractedTextDocument,
  decodeUtf8,
  detectDocumentSourceType,
  getOriginalSizeBytes,
  readDocumentBytes,
} from "./documentUtils.js";

export class MarkdownDocumentParser implements DocumentParser {
  public readonly sourceType = "markdown" as const;

  public canParse(input: DocumentInput): boolean {
    return detectDocumentSourceType(input) === this.sourceType;
  }

  public async parse(input: DocumentParserInput): Promise<ExtractedTextDocument> {
    const bytes = input.text === undefined ? await readDocumentBytes(input) : undefined;
    const rawText = input.text ?? decodeUtf8(bytes ?? new Uint8Array());
    const text = cleanMarkdown(rawText);

    return buildExtractedTextDocument({
      documentInput: input,
      sourceType: this.sourceType,
      parser: "MarkdownDocumentParser",
      text,
      originalSizeBytes: await getOriginalSizeBytes(input, bytes),
    });
  }
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/^---\s*[\s\S]*?\s*---\s*/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s>*-]+/gm, "")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
