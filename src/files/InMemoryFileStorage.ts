import { randomUUID } from "node:crypto";
import type { FileStorage, StoredFile } from "./FileStorage.js";

export class InMemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, Buffer>();

  public async save(buffer: Buffer, _originalName: string): Promise<StoredFile> {
    const storageKey = `mem-${randomUUID()}`;
    this.files.set(storageKey, Buffer.from(buffer));
    return { storageProvider: "memory", storageKey };
  }

  public async read(storageKey: string): Promise<Buffer> {
    const buffer = this.files.get(storageKey);
    if (!buffer) throw new Error("Stored file not found.");
    return Buffer.from(buffer);
  }

  public async delete(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}
