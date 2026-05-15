import type { ExtractedTextDocument } from "../../tools/document/types.js";
import type { DocumentRepository, PersistedDocument } from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, numberValue, optionalText, text, timestamp } from "./rowUtils.js";

export class PostgresDocumentRepository implements DocumentRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(document: ExtractedTextDocument | PersistedDocument): Promise<void> {
    const persisted = toPersistedDocument(document);
    await this.database.query(
      `INSERT INTO documents (
        id, user_id, source_type, file_name, mime_type, source_ref, storage_uri,
        text, text_preview, text_length, parser_status, parser_name, parser_error,
        metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)
      ON CONFLICT (id) DO UPDATE SET
        source_type = EXCLUDED.source_type,
        file_name = EXCLUDED.file_name,
        mime_type = EXCLUDED.mime_type,
        source_ref = EXCLUDED.source_ref,
        storage_uri = EXCLUDED.storage_uri,
        text = EXCLUDED.text,
        text_preview = EXCLUDED.text_preview,
        text_length = EXCLUDED.text_length,
        parser_status = EXCLUDED.parser_status,
        parser_name = EXCLUDED.parser_name,
        parser_error = EXCLUDED.parser_error,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        persisted.documentId,
        persisted.userId,
        persisted.sourceType,
        persisted.fileName,
        persisted.mimeType ?? null,
        persisted.sourceRef,
        persisted.storageUri ?? null,
        persisted.text,
        persisted.textPreview,
        persisted.textLength,
        persisted.parserStatus,
        persisted.parserName ?? null,
        persisted.parserError ?? null,
        JSON.stringify(persisted.metadata),
        persisted.createdAt,
        persisted.updatedAt,
      ],
    );
  }

  public async getById(userId: string, id: string): Promise<PersistedDocument | null> {
    const result = await this.database.query("SELECT * FROM documents WHERE user_id = $1 AND id = $2", [userId, id]);
    return result.rows[0] ? this.toDocument(result.rows[0]) : null;
  }

  public async listByUserId(userId: string): Promise<PersistedDocument[]> {
    const result = await this.database.query("SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return result.rows.map((row) => this.toDocument(row));
  }

  public async delete(userId: string, id: string): Promise<void> {
    await this.database.query("DELETE FROM documents WHERE user_id = $1 AND id = $2", [userId, id]);
  }

  private toDocument(row: Record<string, unknown>): PersistedDocument {
    const metadata = jsonValue<Record<string, unknown>>(row, "metadata");
    return {
      documentId: text(row, "id"),
      userId: text(row, "user_id"),
      sourceType: text(row, "source_type") as PersistedDocument["sourceType"],
      fileName: text(row, "file_name"),
      ...(optionalText(row, "mime_type") ? { mimeType: optionalText(row, "mime_type") } : {}),
      text: optionalText(row, "text") ?? "",
      textPreview: text(row, "text_preview"),
      textLength: numberValue(row, "text_length"),
      sourceRef: text(row, "source_ref"),
      ...(optionalText(row, "storage_uri") ? { storageUri: optionalText(row, "storage_uri") } : {}),
      parserStatus: text(row, "parser_status") as PersistedDocument["parserStatus"],
      ...(optionalText(row, "parser_name") ? { parserName: optionalText(row, "parser_name") } : {}),
      ...(optionalText(row, "parser_error") ? { parserError: optionalText(row, "parser_error") } : {}),
    metadata: {
      ...metadata,
      parser: typeof metadata.parser === "string" ? metadata.parser : optionalText(row, "parser_name") ?? "unknown",
    },
      createdAt: timestamp(row, "created_at"),
      updatedAt: timestamp(row, "updated_at"),
    };
  }
}

function toPersistedDocument(document: ExtractedTextDocument | PersistedDocument): PersistedDocument {
  if ("parserStatus" in document) {
    return document;
  }
  return {
    ...document,
    parserStatus: "parsed",
    parserName: document.metadata.parser,
    updatedAt: document.createdAt,
  };
}
