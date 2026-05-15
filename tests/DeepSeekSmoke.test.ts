import { describe, expect, it } from "vitest";
import { runDeepSeekSmokeDemo } from "../src/examples/deepseek-smoke-demo.js";

const shouldRun = process.env.RUN_DEEPSEEK_SMOKE === "1" && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!shouldRun)("DeepSeek smoke", () => {
  it("calls DeepSeek text and JSON responses", async () => {
    const result = await runDeepSeekSmokeDemo();

    expect(result).toMatchObject({
      skipped: false,
      provider: "deepseek",
    });
  });
});
