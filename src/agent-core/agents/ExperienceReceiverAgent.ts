import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class ExperienceReceiverAgent extends BaseAgent {
  public readonly name = "experience_receiver" as const;
  public readonly allowedTools = [
    "list_experiences",
    "match_experience",
    "match_experiences_against_jd",
    "search_experiences",
    "get_experience",
    "import_experience_candidates_from_text",
    "import_resume_file_as_candidates",
    "accept_import_candidate",
    "reject_import_candidate",
    "prepare_save_experience_from_text",
    "save_experience_from_text",
    "prepare_save_jd_from_text",
    "save_jd_from_text",
    "prepare_update_experience",
    "update_experience",
    "prepare_delete_experience",
    "delete_experience",
    // Phase 3: allow asset-grounded writing centred on a single experience
    // (e.g. "根据 WEEX 实习写一段项目介绍 / 面试可以说的话"). Read-only and
    // strictly scoped by experience-receiver.md — does NOT replace
    // experience.rewrite / save / update / delete flows.
    "compose_career_text",
  ];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
