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
        "Convert raw user experience text into one structured experience JSON object.",
        "Output JSON only.",
        "Do not output Markdown.",
        "Do not output explanation text.",
        "Do not output code blocks.",
        "The output must be directly parseable by JSON.parse.",
        "The output structure must be exactly:",
        "{",
        '  "type": "work | project | education | volunteer | other",',
        '  "organization": "string",',
        '  "role": "string",',
        '  "summary": "string",',
        '  "evidenceExcerpts": ["string"]',
        "}",
        'type: infer the experience type from rawText.',
        'organization: company, school, or project organization; use "Unknown Organization" if unknown.',
        'role: the user role in the experience; use "Contributor" if unknown.',
        "summary: one sentence, no more than 160 characters.",
        "evidenceExcerpts: extract 1-5 original or near-original source sentences that best support the experience.",
        "Do not invent numbers that are not in the source text.",
        "Do not exaggerate outcomes.",
        "Use conservative values when information is insufficient.",
        "Every evidenceExcerpts item must come from rawText.",
      ].join("\n")
    });
  }
}
