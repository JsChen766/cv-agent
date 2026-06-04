import type { AgentFactoryDeps, AgentDomainModule } from "./AgentDomainModule.js";
import type { Agent } from "../agents/BaseAgent.js";
import type { AgentName } from "../validation/AgentOutputSchemas.js";
import type { ToolDefinition } from "../tools/Tool.js";

export class AgentDomainRegistry {
  public constructor(private readonly domains: readonly AgentDomainModule[]) {}

  public createAgents(deps: AgentFactoryDeps): Record<AgentName, Agent> {
    const agents = {} as Record<AgentName, Agent>;
    for (const domain of this.domains) {
      for (const factory of domain.agents ?? []) {
        if (agents[factory.name]) {
          throw new Error(`Duplicate agent name "${factory.name}" in domain "${domain.id}".`);
        }
        agents[factory.name] = factory.create(deps);
      }
    }
    return agents;
  }

  public createTools(): ToolDefinition[] {
    const seen = new Set<string>();
    const tools: ToolDefinition[] = [];
    for (const domain of this.domains) {
      for (const tool of domain.tools ?? []) {
        if (seen.has(tool.name)) {
          throw new Error(`Duplicate tool name "${tool.name}" in domain "${domain.id}".`);
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  public listDomainIds(): string[] {
    return this.domains.map((d) => d.id);
  }
}
