import { describe, expect, it } from "vitest";
import { runDeepSeekSmokeDemo } from "../src/examples/deepseek-smoke-demo.js";

const shouldRun = process.env.RUN_DEEPSEEK_SMOKE === "1" && Boolean(process.env.DEEPSEEK_API_KEY);

describe("DeepSeek smoke skip behavior", () => {
  it("returns skipped when DEEPSEEK_API_KEY is absent", async () => {
    const originalApiKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    try {
      await expect(runDeepSeekSmokeDemo()).resolves.toEqual({
        skipped: true,
        reason: "Set DEEPSEEK_API_KEY to run DeepSeek smoke demo.",
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalApiKey;
      }
    }
  });
});

describe.skipIf(!shouldRun)("DeepSeek smoke", () => {
  it("calls DeepSeek text and JSON responses", async () => {
    const result = await runDeepSeekSmokeDemo();

    expect(result).toMatchObject({
      skipped: false,
      provider: "deepseek",
    });
  });
});
