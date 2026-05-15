import type { DocumentInput, DocumentParser, DocumentParserInput, ExtractedTextDocument } from "./types.js";
import { detectDocumentSourceType, readDocumentBytes } from "./documentUtils.js";

export class DocxDocumentParser implements DocumentParser {
  public readonly sourceType = "docx" as const;

  public canParse(input: DocumentInput): boolean {
    return detectDocumentSourceType(input) === this.sourceType;
  }

  public async parse(input: DocumentParserInput): Promise<ExtractedTextDocument> {
    await readDocumentBytes(input);
    throw new Error("DocxDocumentParser is registered, but DOCX text extraction is not installed yet. Add mammoth or an equivalent parser before ingesting DOCX files.");
  }
}
