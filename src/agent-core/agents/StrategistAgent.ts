import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class StrategistAgent extends BaseAgent {
  public readonly name = "strategist" as const;
  public readonly allowedTools = [
    "list_experiences",
    "search_experiences",
    "get_jd",
    "list_jds",
    "prepare_save_jd_from_text",
    "save_jd_from_text",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
