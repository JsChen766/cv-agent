import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class ExperienceReceiverAgent extends BaseAgent {
  public readonly name = "experience_receiver" as const;
  public readonly allowedTools = [
    "list_experiences",
    "match_experience",
    "search_experiences",
    "get_experience",
    "prepare_save_experience_from_text",
    "save_experience_from_text",
    "prepare_update_experience",
    "update_experience",
    "prepare_delete_experience",
    "delete_experience",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
