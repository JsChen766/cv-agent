import { parseWithSchema } from "../../schemas/validate.js";
import type { BaseAgent } from "../../../core/agent/BaseAgent.js";
import { parseAgentJson } from "../../../core/json/index.js";
import type { IngestExperienceInput } from "../ExperienceIngestionService.js";
import { AgentExtractedExperienceSchema } from "./types.js";
import type { ExperienceExtractionResult, ExperienceExtractor } from "./types.js";

export class AgentExperienceExtractor implements ExperienceExtractor {
  constructor(private readonly agent: BaseAgent) {}

  async extract(input: IngestExperienceInput): Promise<ExperienceExtractionResult> {
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

    const parsed = parseAgentJson(output.content, { expectedRoot: "object" });

    const validated = parseWithSchema(
      AgentExtractedExperienceSchema,
      parsed,
      "AgentExperienceExtractor",
    );

    return {
      experiences: [validated],
      warnings: [],
    };
  }
}
