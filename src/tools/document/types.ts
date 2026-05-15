export type DocumentInput = {
  userId: string;
  fileName: string;
  mimeType?: string;
  extension?: string;
  sourceRef: string;
  filePath?: string;
  buffer?: Uint8Array;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type DocumentSourceType = "pdf" | "docx" | "markdown" | "plain_text";

export type ExtractedTextDocument = {
  documentId: string;
  userId: string;
  sourceType: DocumentSourceType;
  fileName: string;
  mimeType?: string;
  title?: string;
  text: string;
  textPreview: string;
  textLength: number;
  sourceRef: string;
  metadata: {
    parser: string;
    pageCount?: number;
    wordCount?: number;
    originalSizeBytes?: number;
    [key: string]: unknown;
  };
  createdAt: string;
};

export type DocumentParserInput = DocumentInput & {
  text?: string;
};

export type DocumentParser = {
  readonly sourceType: DocumentSourceType;
  canParse(input: DocumentInput): boolean;
  parse(input: DocumentParserInput): Promise<ExtractedTextDocument>;
};
