import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/core/tool/ToolExecutor.js";
import type { ToolCall } from "../src/core/tool/types.js";
import { echoTool } from "../src/tools/echoTool.js";

describe("ToolExecutor", () => {
  it("executes echoTool", async () => {
    const executor = new ToolExecutor();
    executor.register(echoTool);
    const call: ToolCall = {
      type: "function",
      function: {
        name: "echo",
        arguments: JSON.stringify({ message: "hello" })
      }
    };

    await expect(executor.executeToolCall(call)).resolves.toEqual({
      ok: true,
      toolName: "echo",
      result: { message: "hello" }
    });
  });
});
