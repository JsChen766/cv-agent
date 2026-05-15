import type { ModelClient } from "../../core/model/ModelClient.js";
import { stableId } from "../../knowledge/keywordUtils.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import { DeterministicArtifactRevisionAgent } from "./DeterministicArtifactRevisionAgent.js";
import {
  LLMArtifactRevisionParseError,
  parseLLMArtifactRevision,
} from "./LLMArtifactRevisionParser.js";
import {
  buildLLMArtifactRevisionRepairPrompt,
  buildLLMArtifactRevisionSystemPrompt,
  buildLLMArtifactRevisionUserPrompt,
} from "./LLMArtifactRevisionPrompt.js";
import type { LLMArtifactRevisionOutput } from "./LLMArtifactRevisionSchema.js";
import type {
  ArtifactRevisionAgent,
  ArtifactRevisionInput,
  ArtifactRevisionResult,
} from "./types.js";

export type LLMArtifactRevisionAgentOptions = {
  modelClient: ModelClient;
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
};

export class LLMArtifactRevisionAgent implements ArtifactRevisionAgent {
  private readonly modelClient: ModelClient;
  private readonly allowJsonRepair: boolean;
  private readonly allowFallbackToDeterministic: boolean;
  private readonly deterministicAgent = new DeterministicArtifactRevisionAgent();

  public constructor(options: LLMArtifactRevisionAgentOptions) {
    this.modelClient = options.modelClient;
    this.allowJsonRepair = options.allowJsonRepair ?? true;
    this.allowFallbackToDeterministic = options.allowFallbackToDeterministic ?? true;
  }

  public async revise(input: ArtifactRevisionInput): Promise<ArtifactRevisionResult> {
    const response = await this.modelClient.chat({
      messages: [
        {
          role: "system",
          content: buildLLMArtifactRevisionSystemPrompt(),
        },
        {
          role: "user",
          content: buildLLMArtifactRevisionUserPrompt(input),
        },
      ],
      responseFormat: "json",
      temperature: 0.2,
      maxTokens: 2_500,
      metadata: {
        agentName: "revision",
        revision: "LLMArtifactRevisionAgent",
      },
    });

    try {
      return this.toRevisionResult(
        parseLLMArtifactRevision(response.content, input),
        input,
        {
          repaired: false,
          fallbackUsed: false,
        },
      );
    } catch (error) {
      if (!(error instanceof LLMArtifactRevisionParseError)) {
        throw error;
      }
      return this.repairOrFallback(input, response.content, error);
    }
  }

  private async repairOrFallback(
    input: ArtifactRevisionInput,
    raw: string,
    parseError: LLMArtifactRevisionParseError,
  ): Promise<ArtifactRevisionResult> {
    if (this.allowJsonRepair) {
      const repairResponse = await this.modelClient.chat({
        messages: [
          {
            role: "system",
            content: buildLLMArtifactRevisionSystemPrompt(),
          },
          {
            role: "user",
            content: buildLLMArtifactRevisionRepairPrompt({
              invalidResponse: raw,
              parseError: parseError.reason,
            }),
          },
        ],
        responseFormat: "json",
        temperature: 0,
        maxTokens: 2_500,
        metadata: {
          agentName: "revision",
          revision: "LLMArtifactRevisionAgent",
          repair: true,
        },
      });

      try {
        return this.toRevisionResult(
          parseLLMArtifactRevision(repairResponse.content, input),
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
      const fallback = await this.deterministicAgent.revise(input);
      return {
        ...fallback,
        revisedArtifact: {
          ...fallback.revisedArtifact,
          metadata: {
            ...(fallback.revisedArtifact.metadata ?? {}),
            revision: {
              ...readRecord(fallback.revisedArtifact.metadata?.revision),
              llm: {
                provider: this.modelClient.getProviderName(),
                repaired: this.allowJsonRepair,
                fallbackUsed: true,
                fallbackReason: parseError.reason,
              },
            },
          },
        },
        warnings: [
          ...fallback.warnings,
          `LLMArtifactRevisionAgent fell back to deterministic revision: ${parseError.reason}`,
        ],
      };
    }

    throw parseError;
  }

  private toRevisionResult(
    output: LLMArtifactRevisionOutput,
    input: ArtifactRevisionInput,
    flags: {
      repaired: boolean;
      fallbackUsed: boolean;
    },
  ): ArtifactRevisionResult {
    const now = new Date().toISOString();
    const revisedArtifact: GeneratedArtifact = {
      ...input.artifact,
      id: stableId("artifact-revision", `${input.artifact.id}:llm:${output.content}`),
      userId: input.userId,
      content: output.content,
      sourceExperienceIds: unique(output.sourceExperienceIds),
      sourceEvidenceIds: unique(output.sourceEvidenceIds),
      targetRequirementIds: output.targetRequirementIds.length > 0
        ? unique(output.targetRequirementIds)
        : input.artifact.targetRequirementIds,
      status: output.status === "ready" ? "ready" : "needs_review",
      metadata: {
        ...(input.artifact.metadata ?? {}),
        revision: {
          revisedFromArtifactId: input.artifact.id,
          instruction: input.instruction,
          ...(input.customInstruction ? { customInstruction: input.customInstruction } : {}),
          ...(input.tone ? { tone: input.tone } : {}),
          userConfirmations: input.userConfirmations ?? [],
          createdAt: now,
          llm: {
            provider: this.modelClient.getProviderName(),
            repaired: flags.repaired,
            fallbackUsed: flags.fallbackUsed,
          },
        },
        enhancement: {
          status: output.status,
          claims: output.claims.map((claim) => ({
            text: claim.text,
            supportLevel: claim.supportLevel,
            riskLevel: claim.riskLevel,
            evidenceIds: unique(claim.evidenceIds),
            sourceExperienceIds: unique(claim.sourceExperienceIds),
            ...(claim.userConfirmationPrompt
              ? { userConfirmationPrompt: claim.userConfirmationPrompt }
              : {}),
          })),
          confirmationQuestions: output.confirmationQuestions,
          enhancementStrategy: output.enhancementStrategy,
          ...(output.rationale ? { rationale: output.rationale } : {}),
        },
      },
      updatedAt: now,
    };
    return {
      originalArtifact: input.artifact,
      revisedArtifact,
      warnings: output.warnings,
    };
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
