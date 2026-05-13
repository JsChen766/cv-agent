import { AgentRuntimeError } from "../errors/AgentRuntimeError.js";
import type { BaseAgent } from "./BaseAgent.js";

export class AgentRegistry {
  private readonly agents = new Map<string, BaseAgent>();

  public register(agent: BaseAgent): void {
    if (this.agents.has(agent.name)) {
      throw new AgentRuntimeError(`Agent "${agent.name}" is already registered.`, { code: "AGENT_DUPLICATE" });
    }
    this.agents.set(agent.name, agent);
  }

  public get(name: string): BaseAgent {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new AgentRuntimeError(`Agent "${name}" was not found.`, { code: "AGENT_NOT_FOUND" });
    }
    return agent;
  }

  public has(name: string): boolean {
    return this.agents.has(name);
  }

  public list(): string[] {
    return [...this.agents.keys()];
  }
}
