import type { ModelClient } from "../../core/model/ModelClient.js";
import { stableId } from "../../knowledge/keywordUtils.js";
import type {
  ArtifactCritic,
  ArtifactCritiqueReport,
  CritiqueArtifactsInput,
} from "./types.js";
import { DeterministicArtifactCritic } from "./DeterministicArtifactCritic.js";
import {
  LLMArtifactCritiqueParseError,
  parseLLMArtifactCritique,
} from "./LLMArtifactCritiqueParser.js";
import {
  buildLLMArtifactCritiqueRepairPrompt,
  buildLLMArtifactCritiqueSystemPrompt,
  buildLLMArtifactCritiqueUserPrompt,
} from "./LLMArtifactCritiquePrompt.js";
import type { LLMArtifactCritiqueOutput } from "./LLMArtifactCritiqueSchema.js";

export type LLMArtifactCriticOptions = {
  modelClient: ModelClient;
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
};

export class LLMArtifactCritic implements ArtifactCritic {
  private readonly modelClient: ModelClient;
  private readonly allowJsonRepair: boolean;
  private readonly allowFallbackToDeterministic: boolean;
  private readonly deterministicCritic = new DeterministicArtifactCritic();

  public constructor(options: LLMArtifactCriticOptions) {
    this.modelClient = options.modelClient;
    this.allowJsonRepair = options.allowJsonRepair ?? true;
    this.allowFallbackToDeterministic = options.allowFallbackToDeterministic ?? true;
  }

  public async critique(input: CritiqueArtifactsInput): Promise<ArtifactCritiqueReport> {
    const response = await this.modelClient.chat({
      messages: [
        {
          role: "system",
          content: buildLLMArtifactCritiqueSystemPrompt(),
        },
        {
          role: "user",
          content: buildLLMArtifactCritiqueUserPrompt(input),
        },
      ],
      responseFormat: "json",
      temperature: 0,
      maxTokens: 3_000,
      metadata: {
        agentName: "critic",
        critic: "LLMArtifactCritic",
      },
    });

    try {
      return this.toCritiqueReport(
        parseLLMArtifactCritique(response.content, input.artifacts),
        input,
        {
          repaired: false,
          fallbackUsed: false,
          warnings: [],
        },
      );
    } catch (error) {
      if (!(error instanceof LLMArtifactCritiqueParseError)) {
        throw error;
      }
      return this.repairOrFallback(input, response.content, error);
    }
  }

  private async repairOrFallback(
    input: CritiqueArtifactsInput,
    raw: string,
    parseError: LLMArtifactCritiqueParseError,
  ): Promise<ArtifactCritiqueReport> {
    if (this.allowJsonRepair) {
      const repairResponse = await this.modelClient.chat({
        messages: [
          {
            role: "system",
            content: buildLLMArtifactCritiqueSystemPrompt(),
          },
          {
            role: "user",
            content: buildLLMArtifactCritiqueRepairPrompt({
              invalidResponse: raw,
              parseError: parseError.reason,
            }),
          },
        ],
        responseFormat: "json",
        temperature: 0,
        maxTokens: 3_000,
        metadata: {
          agentName: "critic",
          critic: "LLMArtifactCritic",
          repair: true,
        },
      });

      try {
        return this.toCritiqueReport(
          parseLLMArtifactCritique(repairResponse.content, input.artifacts),
          input,
          {
            repaired: true,
            fallbackUsed: false,
            warnings: [],
          },
        );
      } catch (repairError) {
        if (!this.allowFallbackToDeterministic) {
          throw repairError;
        }
      }
    }

    if (this.allowFallbackToDeterministic) {
      const fallback = await this.deterministicCritic.critique(input);
      return {
        ...fallback,
        metadata: {
          ...(fallback.metadata ?? {}),
          critic: "DeterministicArtifactCritic",
          llm: {
            provider: this.modelClient.getProviderName(),
            repaired: this.allowJsonRepair,
            fallbackUsed: true,
            fallbackReason: parseError.reason,
          },
          warnings: [`LLMArtifactCritic fell back to deterministic critique: ${parseError.reason}`],
        },
      };
    }

    throw parseError;
  }

  private toCritiqueReport(
    output: LLMArtifactCritiqueOutput,
    input: CritiqueArtifactsInput,
    flags: {
      repaired: boolean;
      fallbackUsed: boolean;
      warnings: string[];
    },
  ): ArtifactCritiqueReport {
    const createdAt = new Date().toISOString();
    return {
      id: stableId("critique", `${input.userId}:${input.jdId}:${createdAt}:llm`),
      userId: input.userId,
      jdId: input.jdId,
      items: output.items.map((item) => ({
        artifactId: item.artifactId,
        verdict: item.verdict,
        truthfulnessRisk: item.truthfulnessRisk,
        exaggerationRisk: item.exaggerationRisk,
        specificityScore: item.specificityScore,
        evidenceStrengthScore: item.evidenceStrengthScore,
        unsupportedClaims: item.unsupportedClaims,
        missingEvidence: item.missingEvidence,
        rewriteSuggestions: item.rewriteSuggestions,
        ...(item.confirmationQuestions.length > 0
          ? { confirmationQuestions: item.confirmationQuestions }
          : {}),
        ...(item.claimReviews.length > 0 ? { claimReviews: item.claimReviews } : {}),
        ...(item.safeRewriteSuggestion ? { safeRewriteSuggestion: item.safeRewriteSuggestion } : {}),
      })),
      summary: output.summary,
      createdAt,
      metadata: {
        critic: "LLMArtifactCritic",
        llm: {
          provider: this.modelClient.getProviderName(),
          repaired: flags.repaired,
          fallbackUsed: flags.fallbackUsed,
        },
        warnings: [...output.warnings, ...flags.warnings],
      },
    };
  }
}
