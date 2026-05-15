import type { ModelClient } from "../../core/model/ModelClient.js";
import { stableId } from "../../knowledge/keywordUtils.js";
import type { GeneratedArtifact, Skill } from "../../knowledge/types.js";
import type {
  ArtifactGenerator,
  GenerateArtifactsInput,
  GenerateArtifactsResult,
} from "./ArtifactGenerator.js";
import { DeterministicArtifactGenerator } from "./DeterministicArtifactGenerator.js";
import {
  LLMArtifactGenerationParseError,
  parseLLMArtifactGeneration,
} from "./LLMArtifactGenerationParser.js";
import {
  buildLLMArtifactGenerationRepairPrompt,
  buildLLMArtifactGenerationSystemPrompt,
  buildLLMArtifactGenerationUserPrompt,
} from "./LLMArtifactGenerationPrompt.js";
import type { LLMArtifactGenerationOutput, LLMGeneratedArtifact } from "./LLMArtifactGenerationSchema.js";

export type LLMArtifactGeneratorOptions = {
  modelClient: ModelClient;
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
};

export class LLMArtifactGenerator implements ArtifactGenerator {
  private readonly modelClient: ModelClient;
  private readonly allowJsonRepair: boolean;
  private readonly allowFallbackToDeterministic: boolean;
  private readonly deterministicGenerator = new DeterministicArtifactGenerator();

  public constructor(options: LLMArtifactGeneratorOptions) {
    this.modelClient = options.modelClient;
    this.allowJsonRepair = options.allowJsonRepair ?? true;
    this.allowFallbackToDeterministic = options.allowFallbackToDeterministic ?? true;
  }

  public async generate(input: GenerateArtifactsInput): Promise<GenerateArtifactsResult> {
    const response = await this.modelClient.chat({
      messages: [
        {
          role: "system",
          content: buildLLMArtifactGenerationSystemPrompt(),
        },
        {
          role: "user",
          content: buildLLMArtifactGenerationUserPrompt(input),
        },
      ],
      responseFormat: "json",
      temperature: 0.2,
      maxTokens: 4_000,
      metadata: {
        agentName: "architect",
        generator: "LLMArtifactGenerator",
      },
    });

    try {
      return this.toGenerateArtifactsResult(
        parseLLMArtifactGeneration(response.content, this.toValidationContext(input)),
        input,
        {
          repaired: false,
          fallbackUsed: false,
        },
      );
    } catch (error) {
      if (!(error instanceof LLMArtifactGenerationParseError)) {
        throw error;
      }
      return this.repairOrFallback(input, response.content, error);
    }
  }

  private async repairOrFallback(
    input: GenerateArtifactsInput,
    raw: string,
    parseError: LLMArtifactGenerationParseError,
  ): Promise<GenerateArtifactsResult> {
    if (this.allowJsonRepair) {
      const repairResponse = await this.modelClient.chat({
        messages: [
          {
            role: "system",
            content: buildLLMArtifactGenerationSystemPrompt(),
          },
          {
            role: "user",
            content: buildLLMArtifactGenerationRepairPrompt({
              invalidResponse: raw,
              parseError: parseError.reason,
            }),
          },
        ],
        responseFormat: "json",
        temperature: 0,
        maxTokens: 4_000,
        metadata: {
          agentName: "architect",
          generator: "LLMArtifactGenerator",
          repair: true,
        },
      });

      try {
        return this.toGenerateArtifactsResult(
          parseLLMArtifactGeneration(repairResponse.content, this.toValidationContext(input)),
          input,
          {
            repaired: true,
            fallbackUsed: false,
          },
        );
      } catch (repairError) {
        if (!this.allowFallbackToDeterministic) {
          throw repairError;
        }
      }
    }

    if (this.allowFallbackToDeterministic) {
      const fallback = await this.deterministicGenerator.generate(input);
      const fallbackWarning = `LLMArtifactGenerator fell back to deterministic generation: ${parseError.reason}`;
      return {
        artifacts: fallback.artifacts.map((artifact) => ({
          ...artifact,
          metadata: {
            ...(artifact.metadata ?? {}),
            enhancement: {
              ...readEnhancementMetadata(artifact),
              llm: {
                provider: this.modelClient.getProviderName(),
                repaired: this.allowJsonRepair,
                fallbackUsed: true,
              },
            },
          },
        })),
        warnings: [...fallback.warnings, fallbackWarning],
      };
    }

    throw parseError;
  }

  private toGenerateArtifactsResult(
    output: LLMArtifactGenerationOutput,
    input: GenerateArtifactsInput,
    flags: {
      repaired: boolean;
      fallbackUsed: boolean;
    },
  ): GenerateArtifactsResult {
    return {
      artifacts: output.artifacts.map((artifact, index) =>
        this.toGeneratedArtifact(artifact, input, index, flags),
      ),
      warnings: output.warnings,
    };
  }

  private toGeneratedArtifact(
    artifact: LLMGeneratedArtifact,
    input: GenerateArtifactsInput,
    index: number,
    flags: {
      repaired: boolean;
      fallbackUsed: boolean;
    },
  ): GeneratedArtifact {
    const now = new Date().toISOString();
    const skills = input.skills ?? uniqueById(input.retrievedExperiences.flatMap((retrieved) => [
      ...retrieved.skills,
      ...retrieved.matchedSkills,
    ]));
    const matchedSkillIds = this.matchSkillIds(artifact, skills);
    const score = this.scoreArtifact(artifact);
    const sourceEvidenceIds = unique(artifact.sourceEvidenceIds);
    const sourceExperienceIds = unique(artifact.sourceExperienceIds);
    return {
      id: stableId("artifact", `${input.userId}:${input.jdId}:llm-${index}:${artifact.content}`),
      userId: input.userId,
      type: "resume_bullet",
      content: artifact.content,
      sourceExperienceIds,
      sourceEvidenceIds,
      matchedSkillIds,
      targetJDId: input.jdId,
      targetRequirementIds: unique(artifact.targetRequirementIds),
      targetRole: input.targetRole,
      scores: {
        overall: score,
        requirementMatch: score,
        evidenceStrength: sourceEvidenceIds.length > 0 ? 0.85 : 0.2,
      },
      status: artifact.status === "ready" ? "ready" : "needs_review",
      metadata: {
        enhancement: {
          status: artifact.status,
          claims: artifact.claims.map((claim) => ({
            text: claim.text,
            supportLevel: claim.supportLevel,
            riskLevel: claim.riskLevel,
            evidenceIds: unique(claim.evidenceIds),
            sourceExperienceIds: unique(claim.sourceExperienceIds),
            ...(claim.userConfirmationPrompt
              ? { userConfirmationPrompt: claim.userConfirmationPrompt }
              : {}),
          })),
          confirmationQuestions: artifact.confirmationQuestions,
          enhancementStrategy: artifact.enhancementStrategy,
          ...(artifact.rationale ? { rationale: artifact.rationale } : {}),
          llm: {
            provider: this.modelClient.getProviderName(),
            repaired: flags.repaired,
            fallbackUsed: flags.fallbackUsed,
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  private toValidationContext(input: GenerateArtifactsInput) {
    const experiences = input.experiences ?? input.retrievedExperiences.map((retrieved) => retrieved.experience);
    const evidences = input.evidences ?? uniqueById(input.retrievedExperiences.flatMap((retrieved) => [
      ...retrieved.evidences,
      ...retrieved.matchedEvidences,
    ]));
    return {
      evidences,
      experienceIds: experiences.map((experience) => experience.id),
      requirementIds: input.requirements.map((requirement) => requirement.id),
    };
  }

  private matchSkillIds(artifact: LLMGeneratedArtifact, skills: Skill[]): string[] {
    const evidenceIds = new Set(artifact.sourceEvidenceIds);
    const content = artifact.content.toLowerCase();
    return unique(skills
      .filter((skill) =>
        skill.evidenceIds.some((evidenceId) => evidenceIds.has(evidenceId)) ||
        content.includes(skill.name.toLowerCase())
      )
      .map((skill) => skill.id));
  }

  private scoreArtifact(artifact: LLMGeneratedArtifact): number {
    if (artifact.status === "unsafe") {
      return 0.2;
    }
    if (artifact.status === "needs_confirmation") {
      return 0.55;
    }
    return 0.82;
  }
}

function uniqueById<TItem extends { id: string }>(items: TItem[]): TItem[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function readEnhancementMetadata(artifact: GeneratedArtifact): Record<string, unknown> {
  const enhancement = artifact.metadata?.enhancement;
  return typeof enhancement === "object" && enhancement !== null && !Array.isArray(enhancement)
    ? enhancement as Record<string, unknown>
    : {};
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
