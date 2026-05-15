import type { DocumentInput, DocumentParser, DocumentParserInput, ExtractedTextDocument } from "./types.js";
import {
  buildExtractedTextDocument,
  decodeUtf8,
  detectDocumentSourceType,
  getOriginalSizeBytes,
  readDocumentBytes,
} from "./documentUtils.js";

export class PlainTextDocumentParser implements DocumentParser {
  public readonly sourceType = "plain_text" as const;

  public canParse(input: DocumentInput): boolean {
    return detectDocumentSourceType(input) === this.sourceType;
  }

  public async parse(input: DocumentParserInput): Promise<ExtractedTextDocument> {
    const bytes = input.text === undefined ? await readDocumentBytes(input) : undefined;
    const text = (input.text ?? decodeUtf8(bytes ?? new Uint8Array())).trim();

    return buildExtractedTextDocument({
      documentInput: input,
      sourceType: this.sourceType,
      parser: "PlainTextDocumentParser",
      text,
      originalSizeBytes: await getOriginalSizeBytes(input, bytes),
    });
  }
}
