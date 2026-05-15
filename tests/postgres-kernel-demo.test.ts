import { describe, expect, it } from "vitest";
import { runPostgresKernelDemo } from "../src/examples/postgres-kernel-demo.js";

describe("postgres kernel demo", () => {
  it("skips cleanly when DATABASE_URL is not configured", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const result = await runPostgresKernelDemo() as { skipped: boolean; reason: string };

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("DATABASE_URL");
    } finally {
      if (originalDatabaseUrl) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});
