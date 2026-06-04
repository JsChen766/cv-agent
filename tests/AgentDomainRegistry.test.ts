import { describe, expect, it } from "vitest";
import { AgentDomainRegistry } from "../src/agent-core/domain/AgentDomainRegistry.js";
import { careerDomain } from "../src/agent-domains/career/index.js";
import { createAgentTools } from "../src/agent-tools/index.js";
import type { AgentDomainModule } from "../src/agent-core/domain/AgentDomainModule.js";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";

describe("AgentDomainRegistry", () => {
  const promptRegistry = new PromptRegistry();

  it("creates all 5 default career agents", () => {
    const registry = new AgentDomainRegistry([careerDomain]);
    const agents = registry.createAgents({ promptRegistry });
    expect(Object.keys(agents)).toHaveLength(5);
    expect(agents.frontdesk).toBeDefined();
    expect(agents.experience_receiver).toBeDefined();
    expect(agents.strategist).toBeDefined();
    expect(agents.architect).toBeDefined();
    expect(agents.critic).toBeDefined();
  });

  it("creates all default tools preserving order", () => {
    const registry = new AgentDomainRegistry([careerDomain]);
    const tools = registry.createTools();
    const legacy = createAgentTools();

    expect(tools.length).toBe(legacy.length);
    for (let i = 0; i < tools.length; i++) {
      expect(tools[i].name).toBe(legacy[i].name);
    }
  });

  it("listDomainIds returns domain ids", () => {
    const registry = new AgentDomainRegistry([careerDomain]);
    expect(registry.listDomainIds()).toEqual(["career"]);
  });
});

describe("AgentDomainRegistry — error handling", () => {
  const promptRegistry = new PromptRegistry();
  const duplicateTools: AgentDomainModule = {
    id: "dup-tools",
    tools: [
      { name: "list_resumes", description: "", ownerAgent: "architect", mutability: "read" as const, requiresConfirmation: false, riskLevel: "low" as const, inputSchema: {} as never, outputSchema: {} as never, execute: async () => ({ status: "success" }) },
    ],
  };

  it("throws on duplicate agent name", () => {
    const dupAgentDomain: AgentDomainModule = {
      id: "dup",
      agents: [
        { name: "frontdesk", create: () => ({ name: "frontdesk" } as never) },
      ],
    };
    const registry = new AgentDomainRegistry([careerDomain, dupAgentDomain]);
    expect(() => registry.createAgents({ promptRegistry })).toThrow("Duplicate agent name");
  });

  it("throws on duplicate tool name", () => {
    const registry = new AgentDomainRegistry([careerDomain, duplicateTools]);
    expect(() => registry.createTools()).toThrow("Duplicate tool name");
  });
});

describe("createAgentTools backward compatibility", () => {
  it("returns an array of ToolDefinitions", () => {
    const tools = createAgentTools();
    expect(Array.isArray(tools)).toBe(true);
  });

  it("contains expected resume tool ids", () => {
    const toolIds = createAgentTools().map((t) => t.name);
    expect(toolIds).toContain("list_resumes");
    expect(toolIds).toContain("get_resume");
    expect(toolIds).toContain("generate_resume_from_jd");
    expect(toolIds).toContain("accept_generation_variant");
    expect(toolIds).toContain("prepare_revise_resume_item");
    expect(toolIds).toContain("revise_resume_item");
  });

  it("contains expected experience tool ids", () => {
    const toolIds = createAgentTools().map((t) => t.name);
    expect(toolIds).toContain("save_experience_from_text");
    expect(toolIds).toContain("match_experiences_against_jd");
  });
});
