import { describe, expect, it } from "vitest";
import { buildExtractedTextDocument } from "../src/tools/text/types.js";

describe("ExtractedTextDocument", () => {
  it("builds document with text, textPreview, and textLength", () => {
    const document = buildExtractedTextDocument({
      documentId: "doc-1",
      sourceType: "manual_text",
      title: "Manual note",
      text: "hello world",
      sourceRef: "manual://note-1",
      metadata: { owner: "test" }
    });

    expect(document).toMatchObject({
      documentId: "doc-1",
      sourceType: "manual_text",
      title: "Manual note",
      text: "hello world",
      textPreview: "hello world",
      textLength: 11,
      sourceRef: "manual://note-1",
      metadata: { owner: "test" }
    });
  });

  it("uses default previewLength of 500", () => {
    const text = "x".repeat(600);

    const document = buildExtractedTextDocument({
      documentId: "doc-1",
      sourceType: "markdown",
      text,
      sourceRef: "README.md"
    });

    expect(document.textPreview).toHaveLength(500);
    expect(document.textPreview).toBe("x".repeat(500));
    expect(document.textLength).toBe(600);
  });

  it("supports custom previewLength", () => {
    const document = buildExtractedTextDocument({
      documentId: "doc-1",
      sourceType: "pdf_text",
      text: "abcdef",
      sourceRef: "file.pdf",
      previewLength: 3
    });

    expect(document.textPreview).toBe("abc");
  });

  it("defaults metadata to an empty object", () => {
    const document = buildExtractedTextDocument({
      documentId: "doc-1",
      sourceType: "docx_text",
      text: "hello",
      sourceRef: "file.docx"
    });

    expect(document.metadata).toEqual({});
  });

  it("generates documentId and createdAt", () => {
    const document = buildExtractedTextDocument({
      sourceType: "github_text",
      text: "hello",
      sourceRef: "owner/repo:path"
    });

    expect(document.documentId).toMatch(/^text-doc-/);
    expect(document.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(document.createdAt))).toBe(false);
  });
});
