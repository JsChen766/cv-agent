import { parseAgentJson } from "../../core/json/index.js";
import { validateWithSchema } from "../../knowledge/schemas/validate.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import {
  LLMArtifactCritiqueOutputSchema,
  type LLMArtifactCritiqueOutput,
} from "./LLMArtifactCritiqueSchema.js";

export class LLMArtifactCritiqueParseError extends Error {
  public constructor(
    message: string,
    public readonly reason: string,
    public readonly rawPreview: string,
  ) {
    super(message);
    this.name = "LLMArtifactCritiqueParseError";
  }
}

export function parseLLMArtifactCritique(
  raw: string,
  artifacts: GeneratedArtifact[],
): LLMArtifactCritiqueOutput {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(raw, { expectedRoot: "object" });
  } catch (error) {
    throw toParseError("LLM artifact critique response is not valid JSON.", error, raw);
  }

  const validation = validateWithSchema(LLMArtifactCritiqueOutputSchema, parsed);
  if (!validation.ok) {
    throw new LLMArtifactCritiqueParseError(
      `LLM artifact critique schema validation failed: ${validation.errors.join("; ")}`,
      validation.errors.join("; "),
      preview(raw),
    );
  }

  validateCritiqueSemantics(validation.data, artifacts, raw);
  return validation.data;
}

function validateCritiqueSemantics(
  output: LLMArtifactCritiqueOutput,
  artifacts: GeneratedArtifact[],
  raw: string,
): void {
  const errors: string[] = [];
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const seen = new Set<string>();

  for (const item of output.items) {
    if (!artifactIds.has(item.artifactId)) {
      errors.push(`unknown artifactId ${item.artifactId}`);
    }
    if (seen.has(item.artifactId)) {
      errors.push(`duplicate artifactId ${item.artifactId}`);
    }
    seen.add(item.artifactId);

    if (item.verdict === "pass") {
      if (item.unsupportedClaims.length > 0) {
        errors.push(`pass item ${item.artifactId} must not include unsupportedClaims`);
      }
      if (item.missingEvidence.length > 0) {
        errors.push(`pass item ${item.artifactId} must not include missingEvidence`);
      }
      if (item.claimReviews.some((claim) => claim.supportLevel === "unsupported")) {
        errors.push(`pass item ${item.artifactId} must not include unsupported claimReviews`);
      }
      if (item.claimReviews.some((claim) =>
        claim.supportLevel === "needs_user_confirmation" && claim.riskLevel === "high"
      )) {
        errors.push(`pass item ${item.artifactId} must not include high-risk confirmation claimReviews`);
      }
      if (item.claimReviews.some((claim) => claim.supportLevel === "needs_user_confirmation")) {
        errors.push(`pass item ${item.artifactId} must not include needs_user_confirmation claimReviews`);
      }
    }

    if (
      item.claimReviews.some((claim) => claim.supportLevel === "unsupported") &&
      item.verdict === "pass"
    ) {
      errors.push(`unsupported claimReview cannot pass for ${item.artifactId}`);
    }
    if (item.claimReviews.some((claim) => claim.supportLevel === "needs_user_confirmation")) {
      if (item.verdict === "pass") {
        errors.push(`needs_user_confirmation claimReview cannot pass for ${item.artifactId}`);
      }
      if (item.confirmationQuestions.length === 0 && item.missingEvidence.length === 0) {
        errors.push(`needs_user_confirmation claimReview requires confirmationQuestions or missingEvidence for ${item.artifactId}`);
      }
    }
  }

  for (const artifactId of artifactIds) {
    if (!seen.has(artifactId)) {
      errors.push(`missing critique item for artifactId ${artifactId}`);
    }
  }

  if (errors.length > 0) {
    throw new LLMArtifactCritiqueParseError(
      `LLM artifact critique post-validation failed: ${errors.join("; ")}`,
      errors.join("; "),
      preview(raw),
    );
  }
}

function toParseError(message: string, error: unknown, raw: string): LLMArtifactCritiqueParseError {
  const reason = error instanceof Error ? error.message : String(error);
  return new LLMArtifactCritiqueParseError(
    `${message} ${reason}`,
    reason,
    preview(raw),
  );
}

function preview(raw: string): string {
  return raw.slice(0, 300);
}
