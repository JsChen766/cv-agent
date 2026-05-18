import type { ParsedDocument, UploadedFile } from "./types.js";

export type FileRepository = {
  createFile(file: UploadedFile): Promise<UploadedFile>;
  getFile(userId: string, id: string): Promise<UploadedFile | null>;
  listFiles(userId: string, limit?: number): Promise<UploadedFile[]>;
  updateFile(userId: string, id: string, patch: Partial<UploadedFile>): Promise<UploadedFile | null>;
  createParsedDocument(document: ParsedDocument): Promise<ParsedDocument>;
  getParsedDocument(userId: string, id: string): Promise<ParsedDocument | null>;
  getParsedDocumentByFileId(userId: string, fileId: string): Promise<ParsedDocument | null>;
};
