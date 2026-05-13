import { ArchitectAgent } from "../agents/ArchitectAgent.js";
import { CriticAgent } from "../agents/CriticAgent.js";
import { StrategistAgent } from "../agents/StrategistAgent.js";
import { AgentRegistry } from "../core/agent/AgentRegistry.js";
import { ModelClient } from "../core/model/ModelClient.js";
import { Orchestrator } from "../core/workflow/Orchestrator.js";
import { MockProvider } from "../providers/MockProvider.js";

const modelClient = new ModelClient({
  provider: new MockProvider(),
  defaultModel: "mock-model"
});

const registry = new AgentRegistry();
registry.register(new StrategistAgent({ modelClient }));
registry.register(new ArchitectAgent({ modelClient }));
registry.register(new CriticAgent({ modelClient }));

const orchestrator = new Orchestrator(registry);
const result = await orchestrator.runPipeline(["strategist", "architect", "critic"], {
  content: "JD: TypeScript, AI Agent runtime, RAG, resume generation, production quality testing."
});

console.log(JSON.stringify(result.trace, null, 2));
