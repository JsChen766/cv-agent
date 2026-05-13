import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter } from "./StorageAdapter.js";

type StorageEnvelope<T> = {
  key: string;
  value: T;
};

export class FileSystemStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;

  public constructor(baseDir = ".data") {
    this.baseDir = path.resolve(baseDir);
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      const content = await readFile(this.filePath(key), "utf8");
      const envelope = JSON.parse(content) as StorageEnvelope<T>;
      return envelope.value;
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  public async set<T>(key: string, value: T): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const envelope: StorageEnvelope<T> = { key, value };
    await writeFile(this.filePath(key), JSON.stringify(envelope, null, 2), "utf8");
  }

  public async delete(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }

  public async list(prefix = ""): Promise<string[]> {
    await mkdir(this.baseDir, { recursive: true });
    const files = await readdir(this.baseDir);
    const keys: string[] = [];

    for (const file of files.filter((entry) => entry.endsWith(".json"))) {
      const content = await readFile(path.join(this.baseDir, file), "utf8");
      const envelope = JSON.parse(content) as StorageEnvelope<unknown>;
      if (envelope.key.startsWith(prefix)) {
        keys.push(envelope.key);
      }
    }

    return keys;
  }

  private filePath(key: string): string {
    const safeName = Buffer.from(key, "utf8").toString("base64url");
    return path.join(this.baseDir, `${safeName}.json`);
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
