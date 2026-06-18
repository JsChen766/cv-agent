import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class ArchitectAgent extends BaseAgent {
  public readonly name = "architect" as const;
  public readonly allowedTools = [
    "match_experiences_against_jd",
    "get_resume",
    "list_resumes",
    "generate_resume_from_jd",
    "accept_generation_variant",
    "revise_resume_item",
    "prepare_export_resume",
    "export_resume",
    "get_export",
    // Phase 3: open the asset-grounded writing tool to the architect under the
    // strict prompt branch documented in architect.md. compose_career_text is
    // read-only / requiresConfirmation=false / riskLevel=low; it never mutates
    // workspace, never creates pendingActions, and never replaces the
    // generate_resume_from_jd / accept_generation_variant / export_resume
    // pipelines (those branches stay intact).
    "compose_career_text",
    "list_jds",
    "get_jd",
    "list_experiences",
    "get_experience",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
