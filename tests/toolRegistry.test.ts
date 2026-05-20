import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/agent-tools/index.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";

describe("P12 ToolRegistry", () => {
  it("registers tools with schemas and confirmation metadata", () => {
    const tools = createAgentTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(0);
      if (["write", "delete", "export"].includes(tool.mutability)) {
        expect(tool.requiresConfirmation).toBe(true);
      }
      if (tool.mutability === "read") {
        expect(tool.requiresConfirmation).toBe(false);
      }
    }
  });

  it("safely misses unknown tools", () => {
    const registry = new ToolRegistry();
    registry.registerMany(createAgentTools());
    expect(registry.get("unknown_tool")).toBeUndefined();
    expect(registry.has("unknown_tool")).toBe(false);
  });
});
