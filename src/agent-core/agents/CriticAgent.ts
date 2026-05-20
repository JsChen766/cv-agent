import type { ModelClient } from "../../core/model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class CriticAgent extends BaseAgent {
  public readonly name = "critic" as const;
  public readonly allowedTools = [
    "show_evidence",
    "check_unsupported_claims",
    "get_experience",
    "get_resume",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
