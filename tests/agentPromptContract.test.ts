import { describe, expect, it } from "vitest";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { AgentError } from "../src/agent-core/runtime/AgentError.js";
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

  it("returns INVALID_AGENT_OUTPUT when schema validation fails", async () => {
    const kernel = await createP12Kernel();
    const badModel = { chat: async () => ({ content: JSON.stringify({ invalid: true }) }) } as unknown as typeof kernel.frontDeskModelClient;
    const agent = new FrontDeskAgent({ modelClient: badModel, promptRegistry: new PromptRegistry() });
    await expect(agent.decide({ context: testContext(kernel, createAgentTools()) })).rejects.toMatchObject({ code: "INVALID_AGENT_OUTPUT" } satisfies Partial<AgentError>);
    await kernel.close();
  });
});
