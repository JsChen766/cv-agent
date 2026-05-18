import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { FileStorage, StoredFile } from "./FileStorage.js";
import { readPlatformConfig } from "../platform/config.js";

export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  public constructor(root?: string) {
    this.root = resolve(root ?? readPlatformConfig().fileStorageDir);
  }

  public async save(buffer: Buffer, originalName: string): Promise<StoredFile> {
    await mkdir(this.root, { recursive: true });
    const extension = safeExtension(originalName);
    const storageKey = `${randomUUID()}${extension}`;
    await writeFile(this.pathFor(storageKey), buffer);
    return { storageProvider: "local", storageKey };
  }

  public read(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  public async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  private pathFor(storageKey: string): string {
    const fullPath = resolve(join(this.root, storageKey));
    if (!fullPath.startsWith(this.root)) {
      throw new Error("Invalid storage key.");
    }
    return fullPath;
  }
}

function safeExtension(originalName: string): string {
  const extension = extname(originalName).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/.test(extension) ? extension : "";
}
