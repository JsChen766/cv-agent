import mammoth from "mammoth";
import type { DocumentInput, DocumentParser, DocumentParserInput, ExtractedTextDocument } from "./types.js";
import {
  buildExtractedTextDocument,
  detectDocumentSourceType,
  getOriginalSizeBytes,
  readDocumentBytes,
} from "./documentUtils.js";

export class DocxDocumentParser implements DocumentParser {
  public readonly sourceType = "docx" as const;

  public canParse(input: DocumentInput): boolean {
    return detectDocumentSourceType(input) === this.sourceType;
  }

  public async parse(input: DocumentParserInput): Promise<ExtractedTextDocument> {
    const bytes = await readDocumentBytes(input);
    const buffer = Buffer.from(bytes);
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();

    if (!text) {
      throw new Error("DOCX contains no extractable text.");
    }

    const extraMetadata: Record<string, unknown> = {};
    if (result.messages.length > 0) {
      extraMetadata.messages = result.messages.map((m) => ({
        type: m.type,
        message: m.message,
      }));
    }

    return buildExtractedTextDocument({
      documentInput: input,
      sourceType: "docx",
      parser: "DocxDocumentParser",
      text,
      originalSizeBytes: await getOriginalSizeBytes(input, bytes),
      metadata: extraMetadata,
    });
  }
}
