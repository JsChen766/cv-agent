import { stableId } from "../../knowledge/keywordUtils.js";
import type {
  ArtifactClaim,
  ArtifactEnhancementMetadata,
} from "../generators/ArtifactGenerator.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type {
  ArtifactRevisionAgent,
  ArtifactRevisionInput,
  ArtifactRevisionResult,
  UserConfirmation,
} from "./types.js";

export class DeterministicArtifactRevisionAgent implements ArtifactRevisionAgent {
  public async revise(input: ArtifactRevisionInput): Promise<ArtifactRevisionResult> {
    const now = new Date().toISOString();
    const sourceEvidenceIds = unique([
      ...input.artifact.sourceEvidenceIds,
      ...(input.evidenceChain?.sourceEvidences.map((evidence) => evidence.id) ?? []),
    ]);
    const sourceExperienceIds = unique([
      ...input.artifact.sourceExperienceIds,
      ...(input.evidenceChain?.sourceExperiences.map((experience) => experience.id) ?? []),
    ]);
    const revisedContent = this.reviseContent(input);
    const enhancement = this.buildEnhancement(input, revisedContent, sourceEvidenceIds, sourceExperienceIds);
    const status = enhancement.status === "ready" ? "ready" : "needs_review";
    const revisedArtifact: GeneratedArtifact = {
      ...input.artifact,
      id: stableId("artifact-revision", `${input.artifact.id}:${input.instruction}:${revisedContent}`),
      userId: input.userId,
      content: revisedContent,
      sourceExperienceIds,
      sourceEvidenceIds,
      targetRequirementIds: input.targetRequirementIds ?? input.artifact.targetRequirementIds,
      status,
      metadata: {
        ...(input.artifact.metadata ?? {}),
        revision: {
          revisedFromArtifactId: input.artifact.id,
          instruction: input.instruction,
          ...(input.customInstruction ? { customInstruction: input.customInstruction } : {}),
          ...(input.tone ? { tone: input.tone } : {}),
          deterministic: true,
          userConfirmations: input.userConfirmations ?? [],
          createdAt: now,
        },
        enhancement,
      },
      updatedAt: now,
    };
    return {
      originalArtifact: input.artifact,
      revisedArtifact,
      warnings: [],
    };
  }

  private reviseContent(input: ArtifactRevisionInput): string {
    if (
      input.instruction === "remove_unsupported_claims" &&
      input.critiqueItem?.safeRewriteSuggestion
    ) {
      return ensureSentence(input.critiqueItem.safeRewriteSuggestion);
    }

    if (
      input.instruction === "make_more_conservative" ||
      input.instruction === "remove_unsupported_claims" ||
      input.instruction === "custom"
    ) {
      const excerpt = input.evidenceChain?.sourceEvidences[0]?.excerpt;
      return excerpt ? ensureSentence(excerpt) : ensureSentence(`Revised draft: ${input.artifact.content}`);
    }

    if (input.instruction === "make_more_quantified") {
      const numericEvidence = input.evidenceChain?.sourceEvidences
        .find((evidence) => extractNumericTokens(evidence.excerpt).length > 0);
      const confirmation = firstConfirmationWithValue(input.userConfirmations ?? []);
      if (numericEvidence) {
        return ensureSentence(numericEvidence.excerpt);
      }
      if (confirmation) {
        return ensureSentence(`${input.artifact.content} Confirmed metric: ${confirmation}.`);
      }
      return ensureSentence(input.artifact.content);
    }

    return ensureSentence(input.artifact.content);
  }

  private buildEnhancement(
    input: ArtifactRevisionInput,
    content: string,
    sourceEvidenceIds: string[],
    sourceExperienceIds: string[],
  ): ArtifactEnhancementMetadata {
    const confirmations = input.userConfirmations ?? [];
    const hasConfirmation = confirmations.length > 0;
    const hasEvidence = sourceEvidenceIds.length > 0;
    const contentNumbers = extractNumericTokens(content);
    const evidenceNumbers = new Set(extractNumericTokens(
      input.evidenceChain?.sourceEvidences.map((evidence) => evidence.excerpt).join(" ") ?? "",
    ));
    const confirmationNumbers = new Set(confirmations.flatMap((confirmation) => [
      ...(confirmation.metric ? extractNumericTokens(confirmation.metric) : []),
      ...(confirmation.value ? extractNumericTokens(confirmation.value) : []),
      ...(confirmation.explanation ? extractNumericTokens(confirmation.explanation) : []),
    ]));
    const hasUnsupportedNumber = contentNumbers.some((number) =>
      !evidenceNumbers.has(number) && !confirmationNumbers.has(number)
    );
    const shouldConfirm =
      !hasEvidence ||
      hasUnsupportedNumber ||
      (input.instruction === "make_more_quantified" && contentNumbers.length === 0);
    const supportLevel: ArtifactClaim["supportLevel"] = shouldConfirm
      ? "needs_user_confirmation"
      : hasConfirmation
        ? "inferred"
        : "supported";
    const riskLevel: ArtifactClaim["riskLevel"] = shouldConfirm ? "medium" : "low";
    const status = shouldConfirm ? "needs_confirmation" : "ready";
    const confirmationQuestions = shouldConfirm
      ? ["Please confirm the revised claim or provide source evidence before using this bullet."]
      : [];

    return {
      status,
      claims: [{
        text: content,
        supportLevel,
        riskLevel,
        evidenceIds: shouldConfirm ? [] : sourceEvidenceIds,
        sourceExperienceIds: shouldConfirm ? [] : sourceExperienceIds,
        ...(shouldConfirm
          ? { userConfirmationPrompt: confirmationQuestions[0] }
          : {}),
      }],
      confirmationQuestions,
      enhancementStrategy: shouldConfirm ? "confirmation_needed" : "evidence_rewrite",
    };
  }
}

function firstConfirmationWithValue(confirmations: UserConfirmation[]): string | null {
  const confirmation = confirmations.find((item) => item.value || item.metric);
  if (!confirmation) {
    return null;
  }
  return [confirmation.metric, confirmation.value]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function ensureSentence(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function extractNumericTokens(text: string): string[] {
  return Array.from(new Set(text.match(/\$?\d+(?:\.\d+)?%?\+?/g) ?? []));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
