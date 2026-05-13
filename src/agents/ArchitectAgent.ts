import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class ArchitectAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt">) {
    super({
      ...config,
      name: "architect",
      role: "Resume content architect",
      systemPrompt: "Draft concise resume bullets from provided requirements and experience evidence."
    });
  }
}
