import { parseWithSchema } from "../../schemas/validate.js";
import type { BaseAgent } from "../../../core/agent/BaseAgent.js";
import type { IngestExperienceInput } from "../ExperienceIngestionService.js";
import { AgentExtractedExperienceSchema } from "./types.js";
import type { ExperienceExtractor, ExtractedExperience } from "./types.js";

export class AgentExperienceExtractor implements ExperienceExtractor {
  constructor(private readonly agent: BaseAgent) {}

  async extract(input: IngestExperienceInput): Promise<ExtractedExperience> {
    const prompt = [
      `userId: ${input.userId}`,
      `sourceType: ${input.sourceType ?? "raw_input"}`,
      `sourceRef: ${input.sourceRef ?? "raw-experience-input"}`,
      `rawText: ${input.rawText}`,
    ].join("\n");

    const output = await this.agent.run({
      content: prompt,
      responseFormat: "json",
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.content.trim());
    } catch {
      throw new Error(
        `AgentExperienceExtractor: agent output is not valid JSON. Got: ${output.content.slice(0, 200)}`,
      );
    }

    const validated = parseWithSchema(
      AgentExtractedExperienceSchema,
      parsed,
      "AgentExperienceExtractor",
    );

    return validated;
  }
}
