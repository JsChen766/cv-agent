import type { ToolDefinition } from "../../core/tool/types.js";
import { DocxDocumentParser } from "./DocxDocumentParser.js";
import { DocumentParserRegistry } from "./DocumentParserRegistry.js";
import { MarkdownDocumentParser } from "./MarkdownDocumentParser.js";
import { PdfDocumentParser } from "./PdfDocumentParser.js";
import { PlainTextDocumentParser } from "./PlainTextDocumentParser.js";
import type { DocumentInput, ExtractedTextDocument } from "./types.js";

export class DocumentLoaderTool {
  public constructor(private readonly registry: DocumentParserRegistry = createDefaultDocumentParserRegistry()) {}

  public async load(input: DocumentInput): Promise<ExtractedTextDocument> {
    const parser = this.registry.findParser(input);

    if (!parser) {
      throw new Error(`Unsupported document type for "${input.fileName}". Provide mimeType or extension for pdf, docx, markdown, or plain_text.`);
    }

    return parser.parse(input);
  }

  public toToolDefinition(): ToolDefinition {
    return {
      name: "documentLoader",
      description: "Load a user document file and extract text with preview and metadata.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string" },
          fileName: { type: "string" },
          mimeType: { type: "string" },
          extension: { type: "string" },
          sourceRef: { type: "string" },
          filePath: { type: "string" },
          url: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["userId", "fileName", "sourceRef"],
        additionalProperties: true,
      },
      validate: validateDocumentInput,
      execute: async (args) => this.load(args as DocumentInput),
    };
  }
}

export function createDefaultDocumentParserRegistry(): DocumentParserRegistry {
  const registry = new DocumentParserRegistry();
  registry.register(new PdfDocumentParser());
  registry.register(new DocxDocumentParser());
  registry.register(new MarkdownDocumentParser());
  registry.register(new PlainTextDocumentParser());
  return registry;
}

function validateDocumentInput(args: unknown): DocumentInput {
  if (typeof args !== "object" || args === null) {
    throw new Error("DocumentLoaderTool arguments must be an object.");
  }

  const record = args as Record<string, unknown>;
  for (const field of ["userId", "fileName", "sourceRef"]) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw new Error(`DocumentLoaderTool requires ${field}.`);
    }
  }

  return record as DocumentInput;
}
