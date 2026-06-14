import { describe, expect, it } from "vitest";
import type { ContextProvider } from "../src/agent-core/memory/ContextProvider.js";
import { AgentCapabilityRegistry } from "../src/agent-core/capabilities/AgentCapabilityRegistry.js";
import type { AgentCapabilityModule } from "../src/agent-core/capabilities/AgentCapabilityModule.js";
import { createDefaultCapabilities } from "../src/agent-core/capabilities/defaultCapabilities.js";

describe("AgentCapabilityRegistry", () => {
  it("creates a default Noop capability set without registering active providers", () => {
    const registry = new AgentCapabilityRegistry(createDefaultCapabilities());

    expect(registry.listModules()).toEqual([{ id: "core.noop" }]);
    expect(registry.listContextProviders()).toEqual([]);
    expect(registry.listRetrievalProviders()).toEqual([]);
    expect(registry.listMemoryProviders()).toEqual([]);
    expect(registry.listReflectionSinks()).toEqual([]);
    expect(registry.listEvaluationHooks()).toEqual([]);
  });

  it("aggregates providers from registered modules in registration order", () => {
    const contextProvider: ContextProvider = {
      provide: async () => ({ source: "capability-test" }),
    };
    const first: AgentCapabilityModule = {
      id: "first",
      contextProviders: [contextProvider],
      retrievalProviders: [{ id: "retrieval.first" }],
      memoryProviders: [{ id: "memory.first" }],
    };
    const second: AgentCapabilityModule = {
      id: "second",
      reflectionSinks: [{ id: "reflection.second" }],
      evaluationHooks: [{ id: "evaluation.second" }],
    };

    const registry = new AgentCapabilityRegistry([first]);
    registry.register(second);

    expect(registry.listModules().map((module) => module.id)).toEqual(["first", "second"]);
    expect(registry.listContextProviders()).toEqual([contextProvider]);
    expect(registry.listRetrievalProviders().map((provider) => provider.id)).toEqual(["retrieval.first"]);
    expect(registry.listMemoryProviders().map((provider) => provider.id)).toEqual(["memory.first"]);
    expect(registry.listReflectionSinks().map((sink) => sink.id)).toEqual(["reflection.second"]);
    expect(registry.listEvaluationHooks().map((hook) => hook.id)).toEqual(["evaluation.second"]);
  });

  it("rejects duplicate capability module ids", () => {
    const registry = new AgentCapabilityRegistry([{ id: "duplicate" }]);

    expect(() => registry.register({ id: "duplicate" })).toThrow('Duplicate capability module id "duplicate".');
  });
});
