import { describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { createTestKernelContext } from "../src/kernel/index.js";

describe("CvAgentKernel", () => {
  it("runs health, document ingestion, and generation through the facade", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const kernel = await createKernel();

    try {
      const health = await kernel.cvAgentKernel.health();
      expect(health).toEqual({
        ok: true,
        mode: "in_memory",
        warnings: ["DATABASE_URL is not set. API is running in in-memory mode."],
      });

      const ctx = createTestKernelContext({
        user: {
          id: "facade-user",
        },
        request: {
          requestId: "req-facade",
          traceId: "trace-facade",
          source: "test",
        },
      });

      const ingestion = await kernel.cvAgentKernel.documents.ingest(ctx, {
        documents: [{
          userId: ctx.user.id,
          fileName: "resume.md",
          mimeType: "text/markdown",
          sourceRef: "test:resume.md",
          buffer: new TextEncoder().encode([
            "# Resume",
            "As a Frontend Engineer at Acme Corp, I built React and TypeScript systems.",
          ].join("\n")),
        }],
      });

      expect(ingestion.extractedDocuments).toHaveLength(1);
      expect(ingestion.extractedDocuments[0]?.userId).toBe("facade-user");
      expect(ingestion.experiences[0]?.userId).toBe("facade-user");

      const generation = await kernel.cvAgentKernel.generations.create(ctx, {
        jdText: "React TypeScript frontend role.",
        targetRole: "Frontend Engineer",
      });

      expect(generation.artifacts.length).toBeGreaterThan(0);
      expect(generation.artifacts.every((artifact) => artifact.userId === "facade-user")).toBe(true);
      expect(generation.persistedGeneration?.sessionId).toBeTruthy();
      expect(generation.persistedGeneration?.evidenceChainSnapshotCount).toBe(generation.evidenceChains.length);
    } finally {
      await kernel.close();
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});
