import type { DocumentInput, DocumentParser, DocumentParserInput, ExtractedTextDocument } from "./types.js";
import { detectDocumentSourceType, readDocumentBytes } from "./documentUtils.js";

export class PdfDocumentParser implements DocumentParser {
  public readonly sourceType = "pdf" as const;

  public canParse(input: DocumentInput): boolean {
    return detectDocumentSourceType(input) === this.sourceType;
  }

  public async parse(input: DocumentParserInput): Promise<ExtractedTextDocument> {
    await readDocumentBytes(input);
    throw new Error("PdfDocumentParser is registered, but PDF text extraction is not installed yet. Add a PDF parser dependency before ingesting PDF files.");
  }
}
