import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DocumentLoaderTool,
} from "../src/tools/document/index.js";

const MINIMAL_DOCX_BASE64 = "UEsDBBQAAAAIAMCIr1xaK03v8AAAALABAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QS07DMBC9ijVblDh0gRBK0gWUJbAoBxjZk8TCP3nc0p6NBUfiCjht6QIVljPvq/f18dkud86KLSU2wXdwXTcgyKugjR87eF0/VrcgOKPXaIOnDvbEsOzb9T4Si6L13MGUc7yTktVEDrkOkXxBhpAc5nKmUUZUbziSXDTNjVTBZ/K5yrMH9O0DDbixWax25X3skcgyiPsjcc7qAGO0RmEuuNx6/SulOiXURXng8GQiXxUCyIsJM/J3wEn3XIZJRpN4wZSf0BWWfA9JSx3UxhVl/b/NhZ5hGIyis352iykoYi6LO1ufEYfG//SXh7n7b1BLAwQUAAAACADAiK9ckyOaprUAAAAsAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0TeaQoDQqhpF4TUFZUDRImbRjQPJeHRszFwJK5ABgaKGBht//4sP++PqrmZkVwwRO0sg2VRAkErnNRWMTh2+8UGSEzcSj46iwwmjNDU1QFHnvJKHLSPJBs2MhhS8ltKoxjQ8Fg4jzZPehcMT7kMinouTlwhXZXlmoZPA+YmaSWD0MolkG7y+I/t+l4L3DlxNmjTjxNfiSzzoDAxuLogqXy3i8wCrSs6e7F+AVBLAwQUAAAACADAiK9cqkKJFrEAAADiAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRY4xjgIxDEWvEqWHDBQIjWaGAoToaECizU4MjJTYkR0YOBsFR+IKm7DFNs+yvvz8P693s3oEr+7AMhC2ejattALsyQ14afXxsJ0stZJk0VlPCK1+guhV14y1o/4WAJPKApR6bPU1pVgbI/0VgpUpRcCcnYmDTXnlixmJXWTqQST7gzfzqlqYYAfURflD7llmLOCC1O3Ae1JnpqA2+/VJMUh+25iSFfKX8cu/e/PfrfsFUEsDBBQAAAAIAMCIr1zAVV8LfgAAAI8AAAAcAAAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc02MwQ0CIRAAWyH790Afxpjj7mcBRgvYcCsQuYWwxGhtPizJFuTpczKZ+b4/4/xck3pQlZjZwnYwoIhdXiJ7C9fLaXMAJQ15wZSZLLxIYJ7GMyVsPZEQi6j+YLEQWitHrcUFWlGGXIi7ueW6YutYvS7o7uhJ74zZ6/r/AD39AFBLAQIUABQAAAAIAMCIr1xaK03v8AAAALABAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAwIivXJMjmqa1AAAALAEAAAsAAAAAAAAAAAAAAAAAIQEAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgAwIivXKpCiRaxAAAA4gAAABEAAAAAAAAAAAAAAAAA/wEAAHdvcmQvZG9jdW1lbnQueG1sUEsBAhQAFAAAAAgAwIivXMBVXwt+AAAAjwAAABwAAAAAAAAAAAAAAAAA3wIAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNQSwUGAAAAAAQABAADAQAAlwMAAAAA";

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

  it("extracts text from a minimal PDF buffer", async () => {
    const loader = new DocumentLoaderTool();
    const buffer = await readFile(join(process.cwd(), "tests", "fixtures", "resume.pdf"));
    const document = await loader.load({
      userId: "user-1",
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      sourceRef: "upload:resume.pdf",
      buffer,
    });

    expect(document.sourceType).toBe("pdf");
    expect(document.text).toContain("Hello from PDF resume");
    expect(document.metadata.parser).toBe("PdfDocumentParser");
    expect(document.metadata.pageCount).toBe(1);
    expect(document.metadata.originalSizeBytes).toBeGreaterThan(0);
  });

  it("extracts text from a minimal DOCX buffer", async () => {
    const loader = new DocumentLoaderTool();
    const document = await loader.load({
      userId: "user-1",
      fileName: "resume.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourceRef: "upload:resume.docx",
      buffer: Buffer.from(MINIMAL_DOCX_BASE64, "base64"),
    });

    expect(document.sourceType).toBe("docx");
    expect(document.text).toContain("Hello from DOCX resume");
    expect(document.metadata.parser).toBe("DocxDocumentParser");
    expect(document.metadata.originalSizeBytes).toBeGreaterThan(0);
  });

  it("returns a clear unsupported file type error", async () => {
    const loader = new DocumentLoaderTool();

    await expect(loader.load({
      userId: "user-1",
      fileName: "resume.bin",
      mimeType: "application/octet-stream",
      sourceRef: "upload:resume.bin",
      buffer: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow(/Unsupported document type/);
  });

  it("keeps URL loading as a clear error", async () => {
    const loader = new DocumentLoaderTool();

    await expect(loader.load({
      userId: "user-1",
      fileName: "resume.txt",
      mimeType: "text/plain",
      sourceRef: "url:resume.txt",
      url: "https://example.test/resume.txt",
    })).rejects.toThrow(/Document URL loading is not implemented yet/);
  });
});
