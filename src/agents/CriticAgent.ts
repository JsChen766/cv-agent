import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class CriticAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt">) {
    super({
      ...config,
      name: "critic",
      role: "HR reviewer",
      systemPrompt: "Review the draft from an HR perspective and provide concise STAR-oriented improvement suggestions."
    });
  }
}
