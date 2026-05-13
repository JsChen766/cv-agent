import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class ArchivistAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt" | "defaultResponseFormat">) {
    super({
      ...config,
      name: "archivist",
      role: "Experience archivist",
      defaultResponseFormat: "json",
      systemPrompt: "Convert user experience notes into a concise structured experience JSON draft. Keep uncertain fields explicit."
    });
  }
}
