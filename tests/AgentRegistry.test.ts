import { describe, expect, it } from "vitest";
import { BaseAgent } from "../src/core/agent/BaseAgent.js";
import { AgentRegistry } from "../src/core/agent/AgentRegistry.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import { MockProvider } from "../src/providers/MockProvider.js";

class TestAgent extends BaseAgent {
  public constructor(name = "test-agent") {
    super({
      name,
      role: "test",
      systemPrompt: "test",
      modelClient: new ModelClient({
        provider: new MockProvider(),
        defaultModel: "mock-model"
      })
    });
  }
}

describe("AgentRegistry", () => {
  it("registers and gets an agent", () => {
    const registry = new AgentRegistry();
    const agent = new TestAgent();

    registry.register(agent);

    expect(registry.has("test-agent")).toBe(true);
    expect(registry.get("test-agent")).toBe(agent);
    expect(registry.list()).toEqual(["test-agent"]);
  });

  it("throws on duplicate registration", () => {
    const registry = new AgentRegistry();
    registry.register(new TestAgent());

    expect(() => registry.register(new TestAgent())).toThrow(/already registered/);
  });
});
