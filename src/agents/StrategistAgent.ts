import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class StrategistAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt" | "defaultResponseFormat">) {
    super({
      ...config,
      name: "strategist",
      role: "JD strategist",
      defaultResponseFormat: "json",
      systemPrompt: "Analyze a job description and extract the core requirements as JSON."
    });
  }
}
