import { parseAgentJson } from "../../core/json/index.js";
import { validateWithSchema } from "../../knowledge/schemas/validate.js";
import type { EvidenceChain, GeneratedArtifact } from "../../knowledge/types.js";
import type { ArtifactRevisionInput } from "./types.js";
import {
  LLMArtifactRevisionOutputSchema,
  type LLMArtifactRevisionOutput,
} from "./LLMArtifactRevisionSchema.js";

export class LLMArtifactRevisionParseError extends Error {
  public constructor(
    message: string,
    public readonly reason: string,
    public readonly rawPreview: string,
  ) {
    super(message);
    this.name = "LLMArtifactRevisionParseError";
  }
}

export function parseLLMArtifactRevision(
  raw: string,
  input: ArtifactRevisionInput,
): LLMArtifactRevisionOutput {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(raw, { expectedRoot: "object" });
  } catch (error) {
    throw toParseError("LLM artifact revision response is not valid JSON.", error, raw);
  }

  const validation = validateWithSchema(LLMArtifactRevisionOutputSchema, parsed);
  if (!validation.ok) {
    throw new LLMArtifactRevisionParseError(
      `LLM artifact revision schema validation failed: ${validation.errors.join("; ")}`,
      validation.errors.join("; "),
      preview(raw),
    );
  }

  validateRevisionSemantics(validation.data, input, raw);
  return validation.data;
}

function validateRevisionSemantics(
  output: LLMArtifactRevisionOutput,
  input: ArtifactRevisionInput,
  raw: string,
): void {
  const errors: string[] = [];
  const allowedEvidenceIds = new Set(allowedEvidences(input.artifact, input.evidenceChain));
  const allowedExperienceIds = new Set(allowedExperiences(input.artifact, input.evidenceChain));

  if (output.status === "ready" && output.sourceEvidenceIds.length === 0) {
    errors.push("ready revision must include sourceEvidenceIds");
  }
  if (output.status === "ready" && output.claims.some((claim) => claim.supportLevel === "unsupported")) {
    errors.push("ready revision must not include unsupported claims");
  }
  if (output.status === "ready" && output.claims.some((claim) => claim.supportLevel === "needs_user_confirmation")) {
    errors.push("ready revision must not include needs_user_confirmation claims");
  }
  if (
    input.instruction === "remove_unsupported_claims" &&
    output.claims.some((claim) => claim.supportLevel === "unsupported")
  ) {
    errors.push("remove_unsupported_claims revision must not contain unsupported claims");
  }
  if (input.instruction === "make_more_conservative" && output.status === "unsafe") {
    errors.push("make_more_conservative revision must not be unsafe");
  }

  for (const evidenceId of output.sourceEvidenceIds) {
    if (!allowedEvidenceIds.has(evidenceId)) {
      errors.push(`sourceEvidenceIds contains unknown evidence id ${evidenceId}`);
    }
  }
  for (const experienceId of output.sourceExperienceIds) {
    if (!allowedExperienceIds.has(experienceId)) {
      errors.push(`sourceExperienceIds contains unknown experience id ${experienceId}`);
    }
  }

  const sourceEvidenceIds = new Set(output.sourceEvidenceIds);
  for (const [index, claim] of output.claims.entries()) {
    if (claim.supportLevel === "supported" || claim.supportLevel === "inferred") {
      for (const evidenceId of claim.evidenceIds) {
        if (!sourceEvidenceIds.has(evidenceId)) {
          errors.push(`claims[${index}].evidenceIds must be a subset of sourceEvidenceIds`);
        }
      }
    }
    for (const experienceId of claim.sourceExperienceIds) {
      if (!allowedExperienceIds.has(experienceId)) {
        errors.push(`claims[${index}].sourceExperienceIds contains unknown experience id ${experienceId}`);
      }
    }
  }

  if (hasUnconfirmedNewNumber(output, input, allowedEvidenceIds)) {
    errors.push("revision contains a numeric claim not found in cited evidence or user confirmations and must be needs_user_confirmation or unsupported");
  }

  if (errors.length > 0) {
    throw new LLMArtifactRevisionParseError(
      `LLM artifact revision post-validation failed: ${errors.join("; ")}`,
      errors.join("; "),
      preview(raw),
    );
  }
}

function hasUnconfirmedNewNumber(
  output: LLMArtifactRevisionOutput,
  input: ArtifactRevisionInput,
  allowedEvidenceIds: Set<string>,
): boolean {
  const contentNumbers = extractNumericTokens(output.content);
  if (contentNumbers.length === 0) {
    return false;
  }
  const evidenceById = new Map((input.evidenceChain?.sourceEvidences ?? [])
    .map((evidence) => [evidence.id, evidence]));
  const citedEvidenceText = output.sourceEvidenceIds
    .filter((id) => allowedEvidenceIds.has(id))
    .map((id) => evidenceById.get(id)?.excerpt ?? "")
    .join(" ");
  const evidenceNumbers = new Set(extractNumericTokens(citedEvidenceText));
  const confirmationNumbers = new Set((input.userConfirmations ?? []).flatMap((confirmation) => [
    ...(confirmation.metric ? extractNumericTokens(confirmation.metric) : []),
    ...(confirmation.value ? extractNumericTokens(confirmation.value) : []),
    ...(confirmation.explanation ? extractNumericTokens(confirmation.explanation) : []),
  ]));
  const unsupportedNumbers = contentNumbers.filter((number) =>
    !evidenceNumbers.has(number) && !confirmationNumbers.has(number)
  );
  if (unsupportedNumbers.length === 0) {
    return false;
  }
  return !output.claims.some((claim) =>
    claim.supportLevel === "needs_user_confirmation" ||
    claim.supportLevel === "unsupported"
  );
}

function allowedEvidences(artifact: GeneratedArtifact, chain?: EvidenceChain): string[] {
  return unique([
    ...artifact.sourceEvidenceIds,
    ...(chain?.sourceEvidences.map((evidence) => evidence.id) ?? []),
  ]);
}

function allowedExperiences(artifact: GeneratedArtifact, chain?: EvidenceChain): string[] {
  return unique([
    ...artifact.sourceExperienceIds,
    ...(chain?.sourceExperiences.map((experience) => experience.id) ?? []),
  ]);
}

function extractNumericTokens(text: string): string[] {
  return Array.from(new Set(text.match(/\$?\d+(?:\.\d+)?%?\+?/g) ?? []));
}

function toParseError(message: string, error: unknown, raw: string): LLMArtifactRevisionParseError {
  const reason = error instanceof Error ? error.message : String(error);
  return new LLMArtifactRevisionParseError(
    `${message} ${reason}`,
    reason,
    preview(raw),
  );
}

function preview(raw: string): string {
  return raw.slice(0, 300);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
