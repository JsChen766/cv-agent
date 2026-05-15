import type { ModelClient } from "../../core/model/ModelClient.js";
import type { ExperienceType, SkillCategory } from "../types.js";
import type { IngestExperienceInput } from "./ExperienceIngestionService.js";
import { DeterministicExperienceExtractor } from "./extractors/DeterministicExperienceExtractor.js";
import type {
  ExperienceExtractionResult,
  ExperienceExtractor,
  ExtractedSkill,
} from "./extractors/types.js";
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

  public async extract(input: IngestExperienceInput): Promise<ExperienceExtractionResult> {
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
      return this.toExtractionResult(
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
  ): Promise<ExperienceExtractionResult> {
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
        return this.toExtractionResult(
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
      const fallbackWarning = `LLMExperienceExtractor fell back to deterministic extraction: ${parseError.reason}`;
      const totalExtractedExperiences = fallback.experiences.length;
      return {
        ...fallback,
        experiences: fallback.experiences.map((experience, experienceIndex) => ({
          ...experience,
          warnings: [
            ...(experience.warnings ?? []),
            ...(experienceIndex === 0 ? [fallbackWarning] : []),
          ],
          metadata: {
            ...(experience.metadata ?? {}),
            llm: {
              repaired: this.allowJsonRepair,
              fallbackUsed: true,
              truncated,
              experienceIndex,
              totalExtractedExperiences,
            },
          },
        })),
        warnings: [...fallback.warnings, fallbackWarning],
        metadata: {
          ...(fallback.metadata ?? {}),
          llm: {
            repaired: this.allowJsonRepair,
            fallbackUsed: true,
            truncated,
            totalExtractedExperiences,
          },
        },
      };
    }

    throw parseError;
  }

  private toExtractionResult(
    output: LLMExperienceExtractionOutput,
    input: IngestExperienceInput,
    flags: {
      repaired: boolean;
      fallbackUsed: boolean;
      truncated: boolean;
    },
  ): ExperienceExtractionResult {
    if (output.experiences.length === 0) {
      throw new LLMExperienceExtractionParseError(
        "LLM experience extraction returned no experiences.",
        "experiences: empty",
        "",
      );
    }
    const totalExtractedExperiences = output.experiences.length;
    const warnings = [
      ...output.warnings,
      ...(totalExtractedExperiences > 1
        ? [`LLM returned ${totalExtractedExperiences} experiences.`]
        : []),
      ...(flags.truncated ? ["Source text was truncated before LLM extraction."] : []),
    ];

    return {
      experiences: output.experiences.map((experience, experienceIndex) => ({
        type: this.normalizeExperienceType(experience.type),
        organization: experience.organization?.trim() || "Unknown Organization",
        role: experience.role?.trim() || "Contributor",
        summary: experience.summary,
        evidenceExcerpts: experience.evidences.length > 0
          ? experience.evidences.map((evidence) => evidence.excerpt)
          : [experience.summary],
        skillNames: this.extractSkills(experience),
        metadata: {
          llm: {
            provider: this.modelClient.getProviderName(),
            repaired: flags.repaired,
            fallbackUsed: flags.fallbackUsed,
            truncated: flags.truncated,
            experienceIndex,
            totalExtractedExperiences,
          },
          ...(input.sourceDocumentId ? { sourceDocumentId: input.sourceDocumentId } : {}),
        },
      })),
      warnings,
      metadata: {
        llm: {
          provider: this.modelClient.getProviderName(),
          repaired: flags.repaired,
          fallbackUsed: flags.fallbackUsed,
          truncated: flags.truncated,
          totalExtractedExperiences,
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
