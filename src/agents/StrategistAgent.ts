import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";

export class StrategistAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt" | "defaultResponseFormat">) {
    super({
      ...config,
      name: "strategist",
      role: "JD strategist",
      defaultResponseFormat: "json",
      systemPrompt: [
        "Analyze the target role and job description, then extract concrete job requirements.",
        "Only output JSON.",
        "Do not output Markdown.",
        "Do not output code blocks.",
        "Do not output explanation text.",
        "Do not output extra fields.",
        "JSON must be directly parseable by JSON.parse.",
        "The output structure must be exactly:",
        "{",
        '  "requirements": [',
        "    {",
        '      "description": "string",',
        '      "weight": 1',
        "    }",
        "  ]",
        "}",
        "requirements must contain at least 1 item; prefer 3-6 items when the JD has enough signal.",
        "description must be a specific role requirement, not a generic phrase.",
        "weight must be a number from 0 to 1.",
        "Give the most important requirements weights close to 1.",
        "Do not output requiredSkillIds; the system will derive them later.",
        "Return the JSON object only.",
      ].join("\n")
    });
  }
}
