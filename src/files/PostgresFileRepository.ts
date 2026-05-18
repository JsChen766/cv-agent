import type { PostgresQueryable } from "../persistence/postgres/PostgresDatabase.js";
import type { FileRepository } from "./FileRepository.js";
import type { ParsedDocument, UploadedFile } from "./types.js";

export class PostgresFileRepository implements FileRepository {
  public constructor(private readonly database: PostgresQueryable) {}

  public async createFile(file: UploadedFile): Promise<UploadedFile> {
    await this.database.query(
      `INSERT INTO uploaded_file (id,user_id,original_name,mime_type,size_bytes,storage_provider,storage_key,sha256,status,parser_status,parser_error,text_document_id,created_at,updated_at,deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [file.id, file.userId, file.originalName, file.mimeType, file.sizeBytes, file.storageProvider, file.storageKey, file.sha256, file.status, file.parserStatus ?? null, file.parserError ?? null, file.textDocumentId ?? null, file.createdAt, file.updatedAt, file.deletedAt ?? null],
    );
    return file;
  }

  public async getFile(userId: string, id: string): Promise<UploadedFile | null> {
    const result = await this.database.query<any>(`SELECT * FROM uploaded_file WHERE user_id=$1 AND id=$2 AND status <> 'deleted'`, [userId, id]);
    return result.rows[0] ? toFile(result.rows[0]) : null;
  }

  public async listFiles(userId: string, limit = 50): Promise<UploadedFile[]> {
    const result = await this.database.query<any>(`SELECT * FROM uploaded_file WHERE user_id=$1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return result.rows.map(toFile);
  }

  public async updateFile(userId: string, id: string, patch: Partial<UploadedFile>): Promise<UploadedFile | null> {
    await this.database.query(
      `UPDATE uploaded_file SET status=COALESCE($3,status), parser_status=COALESCE($4,parser_status), parser_error=$5, text_document_id=COALESCE($6,text_document_id), deleted_at=COALESCE($7,deleted_at), updated_at=$8 WHERE user_id=$1 AND id=$2`,
      [userId, id, patch.status ?? null, patch.parserStatus ?? null, patch.parserError ?? null, patch.textDocumentId ?? null, patch.deletedAt ?? null, new Date().toISOString()],
    );
    return this.getFile(userId, id);
  }

  public async createParsedDocument(document: ParsedDocument): Promise<ParsedDocument> {
    await this.database.query(
      `INSERT INTO parsed_document (id,user_id,file_id,source_type,text,metadata_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [document.id, document.userId, document.fileId ?? null, document.sourceType, document.text, JSON.stringify(document.metadata ?? {}), document.createdAt],
    );
    return document;
  }

  public async getParsedDocument(userId: string, id: string): Promise<ParsedDocument | null> {
    const result = await this.database.query<any>(`SELECT * FROM parsed_document WHERE user_id=$1 AND id=$2`, [userId, id]);
    return result.rows[0] ? toDocument(result.rows[0]) : null;
  }

  public async getParsedDocumentByFileId(userId: string, fileId: string): Promise<ParsedDocument | null> {
    const result = await this.database.query<any>(`SELECT * FROM parsed_document WHERE user_id=$1 AND file_id=$2 ORDER BY created_at DESC LIMIT 1`, [userId, fileId]);
    return result.rows[0] ? toDocument(result.rows[0]) : null;
  }
}

function toFile(row: any): UploadedFile {
  return { id: row.id, userId: row.user_id, originalName: row.original_name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), storageProvider: row.storage_provider, storageKey: row.storage_key, sha256: row.sha256, status: row.status, parserStatus: row.parser_status ?? undefined, parserError: row.parser_error ?? undefined, textDocumentId: row.text_document_id ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : undefined };
}

function toDocument(row: any): ParsedDocument {
  return { id: row.id, userId: row.user_id, fileId: row.file_id ?? undefined, sourceType: row.source_type, text: row.text, metadata: row.metadata_json ?? undefined, createdAt: new Date(row.created_at).toISOString() };
}
