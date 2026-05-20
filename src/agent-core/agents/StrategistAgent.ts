import type { ModelClient } from "../../core/model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class StrategistAgent extends BaseAgent {
  public readonly name = "strategist" as const;
  public readonly allowedTools = [
    "list_experiences",
    "search_experiences",
    "get_jd",
    "list_jds",
    "check_unsupported_claims",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
