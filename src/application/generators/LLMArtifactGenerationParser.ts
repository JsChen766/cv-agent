import { parseAgentJson } from "../../core/json/index.js";
import { validateWithSchema } from "../../knowledge/schemas/validate.js";
import type { Evidence } from "../../knowledge/types.js";
import {
  LLMArtifactGenerationOutputSchema,
  type LLMArtifactGenerationOutput,
  type LLMGeneratedArtifact,
} from "./LLMArtifactGenerationSchema.js";

export class LLMArtifactGenerationParseError extends Error {
  public constructor(
    message: string,
    public readonly reason: string,
    public readonly rawPreview: string,
  ) {
    super(message);
    this.name = "LLMArtifactGenerationParseError";
  }
}

export type LLMArtifactGenerationValidationContext = {
  evidences: Evidence[];
  experienceIds: string[];
  requirementIds: string[];
};

export function parseLLMArtifactGeneration(
  raw: string,
  context: LLMArtifactGenerationValidationContext,
): LLMArtifactGenerationOutput {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(raw, { expectedRoot: "object" });
  } catch (error) {
    throw toParseError("LLM artifact generation response is not valid JSON.", error, raw);
  }

  const validation = validateWithSchema(LLMArtifactGenerationOutputSchema, parsed);
  if (!validation.ok) {
    throw new LLMArtifactGenerationParseError(
      `LLM artifact generation schema validation failed: ${validation.errors.join("; ")}`,
      validation.errors.join("; "),
      preview(raw),
    );
  }

  validateArtifactSemantics(validation.data, context, raw);
  return validation.data;
}

function validateArtifactSemantics(
  output: LLMArtifactGenerationOutput,
  context: LLMArtifactGenerationValidationContext,
  raw: string,
): void {
  const evidenceById = new Map(context.evidences.map((evidence) => [evidence.id, evidence]));
  const allowedEvidenceIds = new Set(evidenceById.keys());
  const allowedExperienceIds = new Set(context.experienceIds);
  const allowedRequirementIds = new Set(context.requirementIds);

  for (const [index, artifact] of output.artifacts.entries()) {
    const errors: string[] = [];

    if (artifact.sourceEvidenceIds.length === 0) {
      errors.push(`artifacts[${index}].sourceEvidenceIds must not be empty`);
    }
    if (artifact.sourceExperienceIds.length === 0) {
      errors.push(`artifacts[${index}].sourceExperienceIds must not be empty`);
    }
    for (const evidenceId of artifact.sourceEvidenceIds) {
      if (!allowedEvidenceIds.has(evidenceId)) {
        errors.push(`artifacts[${index}].sourceEvidenceIds contains unknown evidence id ${evidenceId}`);
      }
    }
    for (const experienceId of artifact.sourceExperienceIds) {
      if (!allowedExperienceIds.has(experienceId)) {
        errors.push(`artifacts[${index}].sourceExperienceIds contains unknown experience id ${experienceId}`);
      }
    }
    for (const requirementId of artifact.targetRequirementIds) {
      if (!allowedRequirementIds.has(requirementId)) {
        errors.push(`artifacts[${index}].targetRequirementIds contains unknown requirement id ${requirementId}`);
      }
    }

    const artifactEvidenceIds = new Set(artifact.sourceEvidenceIds);
    for (const [claimIndex, claim] of artifact.claims.entries()) {
      if (
        claim.supportLevel === "supported" ||
        claim.supportLevel === "inferred"
      ) {
        for (const evidenceId of claim.evidenceIds) {
          if (!artifactEvidenceIds.has(evidenceId)) {
            errors.push(`artifacts[${index}].claims[${claimIndex}].evidenceIds must be a subset of sourceEvidenceIds`);
          }
        }
      }
      for (const experienceId of claim.sourceExperienceIds) {
        if (!allowedExperienceIds.has(experienceId)) {
          errors.push(`artifacts[${index}].claims[${claimIndex}].sourceExperienceIds contains unknown experience id ${experienceId}`);
        }
      }
    }

    if (artifact.status === "ready") {
      if (artifact.claims.some((claim) => claim.supportLevel === "unsupported")) {
        errors.push(`artifacts[${index}] ready artifact must not include unsupported claims`);
      }
      if (artifact.claims.some((claim) =>
        claim.supportLevel === "needs_user_confirmation" && claim.riskLevel === "high"
      )) {
        errors.push(`artifacts[${index}] ready artifact must not include high-risk confirmation claims`);
      }
    }

    if (
      artifact.claims.some((claim) => claim.supportLevel === "needs_user_confirmation") &&
      artifact.status !== "needs_confirmation"
    ) {
      errors.push(`artifacts[${index}] with confirmation claims must use needs_confirmation status`);
    }

    if (hasUnconfirmedNewNumber(artifact, evidenceById)) {
      errors.push(`artifacts[${index}] contains a numeric claim not present in cited evidence and must include needs_user_confirmation or unsupported claim`);
    }

    if (errors.length > 0) {
      throw new LLMArtifactGenerationParseError(
        `LLM artifact generation post-validation failed: ${errors.join("; ")}`,
        errors.join("; "),
        preview(raw),
      );
    }
  }
}

function hasUnconfirmedNewNumber(
  artifact: LLMGeneratedArtifact,
  evidenceById: Map<string, Evidence>,
): boolean {
  const contentNumbers = extractNumericTokens(artifact.content);
  if (contentNumbers.length === 0) {
    return false;
  }
  const citedEvidenceText = artifact.sourceEvidenceIds
    .map((id) => evidenceById.get(id)?.excerpt ?? "")
    .join(" ");
  const evidenceNumbers = new Set(extractNumericTokens(citedEvidenceText));
  const unsupportedNumbers = contentNumbers.filter((number) => !evidenceNumbers.has(number));
  if (unsupportedNumbers.length === 0) {
    return false;
  }
  return !artifact.claims.some((claim) =>
    claim.supportLevel === "needs_user_confirmation" ||
    claim.supportLevel === "unsupported"
  );
}

function extractNumericTokens(text: string): string[] {
  return Array.from(new Set(text.match(/\$?\d+(?:\.\d+)?%?\+?/g) ?? []));
}

function toParseError(message: string, error: unknown, raw: string): LLMArtifactGenerationParseError {
  const reason = error instanceof Error ? error.message : String(error);
  return new LLMArtifactGenerationParseError(
    `${message} ${reason}`,
    reason,
    preview(raw),
  );
}

function preview(raw: string): string {
  return raw.slice(0, 300);
}
