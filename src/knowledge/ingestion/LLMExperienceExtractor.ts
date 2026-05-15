import type { ModelClient } from "../../core/model/ModelClient.js";
import type { ExperienceType, SkillCategory } from "../types.js";
import type { IngestExperienceInput } from "./ExperienceIngestionService.js";
import { DeterministicExperienceExtractor } from "./extractors/DeterministicExperienceExtractor.js";
import type { ExperienceExtractor, ExtractedExperience, ExtractedSkill } from "./extractors/types.js";
import {
  LLMExperienceExtractionParseError,
  parseLLMExperienceExtraction,
} from "./LLMExperienceExtractionParser.js";
import {
  buildLLMExperienceExtractionRepairPrompt,
  buildLLMExperienceExtractionSystemPrompt,
  buildLLMExperienceExtractionUserPrompt,
} from "./LLMExperienceExtractionPrompt.js";
import type {
  LLMExperienceExtractionOutput,
  LLMExtractedExperience,
} from "./LLMExperienceExtractionSchema.js";

export type LLMExperienceExtractorOptions = {
  modelClient: ModelClient;
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
};

export class LLMExperienceExtractor implements ExperienceExtractor {
  private readonly modelClient: ModelClient;
  private readonly allowJsonRepair: boolean;
  private readonly allowFallbackToDeterministic: boolean;
  private readonly deterministicExtractor = new DeterministicExperienceExtractor();

  public constructor(options: LLMExperienceExtractorOptions) {
    this.modelClient = options.modelClient;
    this.allowJsonRepair = options.allowJsonRepair ?? true;
    this.allowFallbackToDeterministic = options.allowFallbackToDeterministic ?? true;
  }

  public async extract(input: IngestExperienceInput): Promise<ExtractedExperience> {
    const prompt = buildLLMExperienceExtractionUserPrompt(input);
    const response = await this.modelClient.chat({
      messages: [
        {
          role: "system",
          content: buildLLMExperienceExtractionSystemPrompt(),
        },
        {
          role: "user",
          content: prompt.prompt,
        },
      ],
      responseFormat: "json",
      temperature: 0,
      maxTokens: 3_000,
      metadata: {
        agentName: "archivist",
        extractor: "LLMExperienceExtractor",
      },
    });

    try {
      return this.toExtractedExperience(
        parseLLMExperienceExtraction(response.content),
        input,
        {
          repaired: false,
          fallbackUsed: false,
          truncated: prompt.truncated,
        },
      );
    } catch (error) {
      if (!(error instanceof LLMExperienceExtractionParseError)) {
        throw error;
      }
      return this.repairOrFallback(input, response.content, error, prompt.truncated);
    }
  }

  private async repairOrFallback(
    input: IngestExperienceInput,
    raw: string,
    parseError: LLMExperienceExtractionParseError,
    truncated: boolean,
  ): Promise<ExtractedExperience> {
    if (this.allowJsonRepair) {
      const repairResponse = await this.modelClient.chat({
        messages: [
          {
            role: "system",
            content: buildLLMExperienceExtractionSystemPrompt(),
          },
          {
            role: "user",
            content: buildLLMExperienceExtractionRepairPrompt({
              invalidResponse: raw,
              parseError: parseError.reason,
            }),
          },
        ],
        responseFormat: "json",
        temperature: 0,
        maxTokens: 3_000,
        metadata: {
          agentName: "archivist",
          extractor: "LLMExperienceExtractor",
          repair: true,
        },
      });

      try {
        return this.toExtractedExperience(
          parseLLMExperienceExtraction(repairResponse.content),
          input,
          {
            repaired: true,
            fallbackUsed: false,
            truncated,
          },
        );
      } catch (repairError) {
        if (!this.allowFallbackToDeterministic) {
          throw repairError;
        }
      }
    }

    if (this.allowFallbackToDeterministic) {
      const fallback = await this.deterministicExtractor.extract(input);
      return {
        ...fallback,
        warnings: [
          ...(fallback.warnings ?? []),
          `LLMExperienceExtractor fell back to deterministic extraction: ${parseError.reason}`,
        ],
        metadata: {
          ...(fallback.metadata ?? {}),
          llm: {
            repaired: this.allowJsonRepair,
            fallbackUsed: true,
            truncated,
          },
        },
      };
    }

    throw parseError;
  }

  private toExtractedExperience(
    output: LLMExperienceExtractionOutput,
    input: IngestExperienceInput,
    flags: {
      repaired: boolean;
      fallbackUsed: boolean;
      truncated: boolean;
    },
  ): ExtractedExperience {
    const primary = output.experiences[0];
    if (!primary) {
      throw new LLMExperienceExtractionParseError(
        "LLM experience extraction returned no experiences.",
        "experiences: empty",
        "",
      );
    }
    const warnings = [
      ...output.warnings,
      ...(output.experiences.length > 1
        ? [`LLM returned ${output.experiences.length} experiences; only the first was ingested.`]
        : []),
      ...(flags.truncated ? ["Source text was truncated before LLM extraction."] : []),
    ];

    return {
      type: this.normalizeExperienceType(primary.type),
      organization: primary.organization?.trim() || "Unknown Organization",
      role: primary.role?.trim() || "Contributor",
      summary: primary.summary,
      evidenceExcerpts: primary.evidences.length > 0
        ? primary.evidences.map((evidence) => evidence.excerpt)
        : [primary.summary],
      skillNames: this.extractSkills(primary),
      warnings,
      metadata: {
        llm: {
          provider: this.modelClient.getProviderName(),
          repaired: flags.repaired,
          fallbackUsed: flags.fallbackUsed,
          truncated: flags.truncated,
        },
        ...(input.sourceDocumentId ? { sourceDocumentId: input.sourceDocumentId } : {}),
      },
    };
  }

  private extractSkills(experience: LLMExtractedExperience): ExtractedSkill[] {
    const skills = new Map<string, ExtractedSkill>();
    for (const skill of experience.skills) {
      this.addSkill(skills, skill.name, this.normalizeSkillCategory(skill.category));
    }
    for (const evidence of experience.evidences) {
      for (const skillName of evidence.skillNames ?? []) {
        this.addSkill(skills, skillName, undefined);
      }
    }
    return Array.from(skills.values());
  }

  private addSkill(
    skills: Map<string, ExtractedSkill>,
    rawName: string,
    category: SkillCategory | undefined,
  ): void {
    const name = rawName.trim();
    if (!name) {
      return;
    }
    const key = name.toLowerCase();
    if (!skills.has(key)) {
      skills.set(key, {
        name,
        ...(category ? { category } : {}),
      });
    }
  }

  private normalizeExperienceType(value: string | undefined): ExperienceType {
    if (
      value === "work" ||
      value === "project" ||
      value === "education" ||
      value === "volunteer" ||
      value === "other"
    ) {
      return value;
    }
    return "other";
  }

  private normalizeSkillCategory(value: string | undefined): SkillCategory | undefined {
    if (value === "technical" || value === "domain" || value === "soft") {
      return value;
    }
    return undefined;
  }
}
