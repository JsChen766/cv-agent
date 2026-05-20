import { describe, expect, it } from "vitest";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { FrontDeskAgent } from "../src/agent-core/agents/FrontDeskAgent.js";
import { createAgentTools } from "../src/agent-tools/index.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

describe("P12 agent prompt contract", () => {
  it("has prompts and allowed tools for all five agents", () => {
    const prompts = new PromptRegistry();
    for (const name of ["frontdesk", "experience_receiver", "strategist", "architect", "critic"] as const) {
      expect(prompts.get(name)).toContain("Allowed tools");
    }
    const toolNames = createAgentTools().map((tool) => tool.name);
    expect(toolNames).toContain("list_experiences");
    expect(toolNames).toContain("check_unsupported_claims");
  });

  it("returns a valid decision instead of throwing when model output is invalid", async () => {
    const kernel = await createP12Kernel();
    const badModel = { chat: async () => ({ content: JSON.stringify({ invalid: true }) }) } as unknown as typeof kernel.frontDeskModelClient;
    const agent = new FrontDeskAgent({ modelClient: badModel, promptRegistry: new PromptRegistry() });
    // Should not throw — repair+fallback should produce a valid decision
    const result = await agent.decide({ context: testContext(kernel, createAgentTools()) });
    expect(result.agentName).toBe("frontdesk");
    expect(result.responseType).toBeDefined();
    expect(result.assistantMessage).toBeTruthy();
    expect(result.assistantMessage).not.toContain("cannot safely");
    expect(Array.isArray(result.plan)).toBe(true);
    expect(Array.isArray(result.missingInputs)).toBe(true);
    await kernel.close();
  });

  it("returns a valid decision without modelClient instead of throwing", async () => {
    const kernel = await createP12Kernel();
    const agent = new FrontDeskAgent({ promptRegistry: new PromptRegistry() });
    const ctx = testContext(kernel, createAgentTools());
    const ctxWithMsg = { ...ctx, userMessage: "你好" };
    const result = await agent.decide({ context: ctxWithMsg });
    expect(result.agentName).toBe("frontdesk");
    expect(result.responseType).toBe("final");
    expect(result.assistantMessage).toBeTruthy();
    expect(result.assistantMessage).not.toContain("cannot safely");
    await kernel.close();
  });
});
