import { describe, expect, it } from "vitest";
import {
  DocumentLoaderTool,
  DocxDocumentParser,
  PdfDocumentParser,
} from "../src/tools/document/index.js";

describe("document tools", () => {
  it("loads markdown from a file buffer and returns extracted text metadata", async () => {
    const loader = new DocumentLoaderTool();
    const document = await loader.load({
      userId: "user-1",
      fileName: "resume.md",
      mimeType: "text/markdown",
      sourceRef: "upload:resume.md",
      buffer: new TextEncoder().encode([
        "---",
        "title: Resume",
        "---",
        "# Frontend work",
        "Built **React** components for a [design system](https://example.test).",
      ].join("\n")),
      metadata: { uploadId: "upload-1" },
    });

    expect(document.sourceType).toBe("markdown");
    expect(document.text).toContain("Frontend work");
    expect(document.text).toContain("Built React components for a design system.");
    expect(document.text).not.toContain("---");
    expect(document.textPreview).toBe(document.text.slice(0, 500));
    expect(document.textLength).toBe(document.text.length);
    expect(document.metadata.parser).toBe("MarkdownDocumentParser");
    expect(document.metadata.wordCount).toBeGreaterThan(0);
    expect(document.metadata.originalSizeBytes).toBeGreaterThan(0);
    expect(document.metadata.uploadId).toBe("upload-1");
  });

  it("loads plain text from a buffer", async () => {
    const loader = new DocumentLoaderTool();
    const document = await loader.load({
      userId: "user-1",
      fileName: "note.txt",
      mimeType: "text/plain",
      sourceRef: "chat:note",
      buffer: new TextEncoder().encode("Built TypeScript APIs."),
    });

    expect(document.sourceType).toBe("plain_text");
    expect(document.text).toBe("Built TypeScript APIs.");
    expect(document.metadata.parser).toBe("PlainTextDocumentParser");
  });

  it("keeps PDF parser interface with a clear missing dependency error", async () => {
    await expect(new PdfDocumentParser().parse({
      userId: "user-1",
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      sourceRef: "upload:resume.pdf",
      buffer: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow(/PDF text extraction is not installed yet/);
  });

  it("keeps DOCX parser interface with a clear missing dependency error", async () => {
    await expect(new DocxDocumentParser().parse({
      userId: "user-1",
      fileName: "resume.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourceRef: "upload:resume.docx",
      buffer: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow(/DOCX text extraction is not installed yet/);
  });
});
