import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/agent-tools/index.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";

const productionFiles = [
  "src/api/routes/copilot.ts",
  "src/copilot/CopilotOrchestrator.ts",
  "src/agent-core/runtime/AgentOrchestrator.ts",
  "src/api/kernel/createKernel.ts",
  "src/providers/DeepSeekProvider.ts",
  "src/providers/OpenAICompatibleProvider.ts",
];

describe("P12.2 architecture consolidation", () => {
  it("production Copilot path no longer imports old agents tools/runtime", async () => {
    for (const file of productionFiles) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("agents/tools");
      expect(source).not.toContain("agents/runtime");
      expect(source).not.toContain("agents/frontdesk");
      expect(source).not.toContain("providers/factory");
      expect(source).not.toContain("MockProvider");
    }
  });

  it("uses the new ToolRegistry and createAgentTools as the business tool entrypoint", () => {
    const registry = new ToolRegistry();
    registry.registerMany(createAgentTools());
    const tools = registry.list();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_experiences",
      "save_experience_from_text",
      "export_resume",
      "check_unsupported_claims",
    ]));
    for (const tool of tools) {
      expect(tool).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        ownerAgent: expect.any(String),
        mutability: expect.any(String),
        requiresConfirmation: expect.any(Boolean),
        riskLevel: expect.any(String),
      });
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.execute).toEqual(expect.any(Function));
    }
  });
});
