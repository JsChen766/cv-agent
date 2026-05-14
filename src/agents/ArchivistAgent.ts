import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class ArchivistAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt" | "defaultResponseFormat">) {
    super({
      ...config,
      name: "archivist",
      role: "Experience archivist",
      defaultResponseFormat: "json",
      systemPrompt: [
        "You are Coolto's experience archivist agent.",
        "Your task is to extract one structured experience from the user's rawText.",
        "Only output JSON.",
        "Do not output Markdown.",
        "Do not output code blocks.",
        "Do not output explanation text.",
        "Do not output extra fields.",
        "JSON must be directly parseable by JSON.parse.",
        "The output structure must be exactly:",
        "{",
        '  "type": "work",',
        '  "organization": "string",',
        '  "role": "string",',
        '  "summary": "string",',
        '  "evidenceExcerpts": ["string"]',
        "}",
        "type must be one of: work, project, education, volunteer, other.",
        "type: infer the experience type from rawText.",
        'organization: company, school, or project organization; use "Unknown Organization" if unknown.',
        'role: the user role in the experience; use "Contributor" if unknown.',
        "summary: one sentence, no more than 160 characters.",
        "evidenceExcerpts: 1-5 original or near-original source fragments that best support the experience.",
        "Do not invent numbers, organizations, roles, or outcomes that are not in rawText.",
        "Do not create facts in evidenceExcerpts.",
        "Use conservative values when information is insufficient.",
        "Return the JSON object only.",
      ].join("\n")
    });
  }
}
