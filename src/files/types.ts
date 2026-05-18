export type FileStorageProvider = "local" | "memory" | "r2" | "s3";
export type UploadedFileStatus = "uploaded" | "parsed" | "failed" | "deleted";
export type ParsedDocumentSourceType = "pdf" | "docx" | "text" | "paste";

export type UploadedFile = {
  id: string;
  userId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storageProvider: FileStorageProvider;
  storageKey: string;
  sha256: string;
  status: UploadedFileStatus;
  parserStatus?: string;
  parserError?: string;
  textDocumentId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ParsedDocument = {
  id: string;
  userId: string;
  fileId?: string;
  sourceType: ParsedDocumentSourceType;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};
