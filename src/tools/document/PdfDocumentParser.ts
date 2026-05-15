import { createRequire } from "node:module";
import type { DocumentInput, DocumentParser, DocumentParserInput, ExtractedTextDocument } from "./types.js";
import {
  buildExtractedTextDocument,
  detectDocumentSourceType,
  getOriginalSizeBytes,
  readDocumentBytes,
} from "./documentUtils.js";

const require = createRequire(import.meta.url);
const pdfjsLib = require("pdfjs-dist") as {
  getDocument: (data: { data: Uint8Array }) => { promise: Promise<PDFDocumentProxy> };
};

interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
}

interface PDFPageProxy {
  getTextContent(): Promise<{ items: Array<{ str: string }> }>;
}

export class PdfDocumentParser implements DocumentParser {
  public readonly sourceType = "pdf" as const;

  public canParse(input: DocumentInput): boolean {
    return detectDocumentSourceType(input) === this.sourceType;
  }

  public async parse(input: DocumentParserInput): Promise<ExtractedTextDocument> {
    const bytes = await readDocumentBytes(input);
    const pdfBytes = new Uint8Array(bytes.byteLength);
    pdfBytes.set(bytes);

    const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    const pageCount = doc.numPages;
    const pageTexts: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      pageTexts.push(pageText);
    }

    const text = pageTexts.join("\n").trim();
    if (!text) {
      throw new Error("PDF contains no extractable text. Scanned or image-based PDFs are not supported.");
    }

    return buildExtractedTextDocument({
      documentInput: input,
      sourceType: "pdf",
      parser: "PdfDocumentParser",
      text,
      pageCount,
      originalSizeBytes: await getOriginalSizeBytes(input, bytes),
    });
  }
}
