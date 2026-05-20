import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class ArchitectAgent extends BaseAgent {
  public readonly name = "architect" as const;
  public readonly allowedTools = [
    "get_resume",
    "list_resumes",
    "generate_resume_from_jd",
    "revise_resume_item",
    "prepare_export_resume",
    "export_resume",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
