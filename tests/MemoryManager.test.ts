import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryManager } from "../src/core/memory/MemoryManager.js";
import { FileSystemStorageAdapter } from "../src/core/storage/FileSystemStorageAdapter.js";

let tempDir: string;

describe("MemoryManager", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "coolto-memory-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("sets and gets messages through storage", async () => {
    const memory = new MemoryManager(new FileSystemStorageAdapter(tempDir));

    await memory.appendMessage("s1", { role: "user", content: "hello" });
    await memory.appendMessage("s1", { role: "assistant", content: "world" });

    await expect(memory.getMessages("s1")).resolves.toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" }
    ]);
  });
});
