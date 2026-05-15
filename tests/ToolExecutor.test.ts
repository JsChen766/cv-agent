import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/core/tool/ToolExecutor.js";
import type { ToolCall, ToolDefinition } from "../src/core/tool/types.js";
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

  it("passes parsed args to validate", async () => {
    const receivedArgs: unknown[] = [];
    const tool: ToolDefinition = {
      name: "validated",
      description: "Validated tool.",
      parameters: { type: "object" },
      validate(args: unknown): unknown {
        receivedArgs.push(args);
        return args;
      },
      async execute(args: unknown): Promise<unknown> {
        return args;
      }
    };
    const executor = new ToolExecutor();
    executor.register(tool);

    await executor.executeToolCall({
      type: "function",
      function: {
        name: "validated",
        arguments: JSON.stringify({ count: 1 })
      }
    });

    expect(receivedArgs).toEqual([{ count: 1 }]);
  });

  it("passes validated args to execute", async () => {
    const executedArgs: unknown[] = [];
    const tool: ToolDefinition = {
      name: "validated",
      description: "Validated tool.",
      parameters: { type: "object" },
      validate(): unknown {
        return { count: 2 };
      },
      async execute(args: unknown): Promise<unknown> {
        executedArgs.push(args);
        return args;
      }
    };
    const executor = new ToolExecutor();
    executor.register(tool);

    const result = await executor.executeToolCall({
      type: "function",
      function: {
        name: "validated",
        arguments: JSON.stringify({ count: 1 })
      }
    });

    expect(executedArgs).toEqual([{ count: 2 }]);
    expect(result).toEqual({
      ok: true,
      toolName: "validated",
      result: { count: 2 }
    });
  });

  it("returns ok false when validate throws", async () => {
    const tool: ToolDefinition = {
      name: "validated",
      description: "Validated tool.",
      parameters: { type: "object" },
      validate(): unknown {
        throw new Error("Invalid args.");
      },
      async execute(): Promise<unknown> {
        return { shouldNotRun: true };
      }
    };
    const executor = new ToolExecutor();
    executor.register(tool);

    await expect(executor.executeToolCall({
      type: "function",
      function: {
        name: "validated",
        arguments: JSON.stringify({ count: 1 })
      }
    })).resolves.toEqual({
      ok: false,
      toolName: "validated",
      error: "Invalid args."
    });
  });

  it("still executes tools without validate", async () => {
    const tool: ToolDefinition = {
      name: "plain",
      description: "Plain tool.",
      parameters: { type: "object" },
      async execute(args: unknown): Promise<unknown> {
        return args;
      }
    };
    const executor = new ToolExecutor();
    executor.register(tool);

    await expect(executor.executeToolCall({
      type: "function",
      function: {
        name: "plain",
        arguments: JSON.stringify({ ok: true })
      }
    })).resolves.toEqual({
      ok: true,
      toolName: "plain",
      result: { ok: true }
    });
  });

  it("returns ok false for invalid JSON arguments", async () => {
    const executor = new ToolExecutor();
    executor.register(echoTool);

    const result = await executor.executeToolCall({
      type: "function",
      function: {
        name: "echo",
        arguments: "{ invalid json"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.toolName).toBe("echo");
    expect(result.error).toMatch(/json|expected|unexpected/i);
  });
});
