import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class ArchitectAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt">) {
    super({
      ...config,
      name: "architect",
      role: "Resume content architect",
      defaultResponseFormat: "json",
      systemPrompt: [
        "Draft resume artifacts from the provided requirements, retrieved experiences, and evidence.",
        "Only output a JSON array.",
        "Do not output Markdown.",
        "Do not output code blocks.",
        "Do not output explanation text.",
        "JSON must be directly parseable by JSON.parse.",
        "Output at least 3 artifacts.",
        "Each item must have exactly this structure:",
        "[",
        "  {",
        '    "type": "resume_bullet",',
        '    "content": "string",',
        '    "sourceExperienceIds": ["string"],',
        '    "sourceEvidenceIds": ["string"],',
        '    "matchedSkillIds": ["string"],',
        '    "targetRequirementIds": ["string"]',
        "  }",
        "]",
        "type must be one of: resume_bullet, resume_summary, cover_letter_snippet.",
        "content must be grounded in the retrieved experiences and evidence.",
        "Do not invent sourceExperienceIds, sourceEvidenceIds, matchedSkillIds, or targetRequirementIds.",
        "If evidence is insufficient, still output 3 artifacts, but sourceEvidenceIds may be empty.",
        "Do not create numbers that are not present in the provided evidence.",
        "Prefer varied angles: technical, product impact, architecture or system design.",
        "Do not output scores, status, id, createdAt, or updatedAt; the system will add them.",
        "Return the JSON array only.",
      ].join("\n")
    });
  }
}
