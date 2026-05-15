import { parseAgentJson } from "../../core/json/index.js";
import { validateWithSchema } from "../schemas/validate.js";
import {
  LLMExperienceExtractionOutputSchema,
  type LLMExperienceExtractionOutput,
} from "./LLMExperienceExtractionSchema.js";

export class LLMExperienceExtractionParseError extends Error {
  public constructor(
    message: string,
    public readonly reason: string,
    public readonly rawPreview: string,
  ) {
    super(message);
    this.name = "LLMExperienceExtractionParseError";
  }
}

export function parseLLMExperienceExtraction(raw: string): LLMExperienceExtractionOutput {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(raw, { expectedRoot: "object" });
  } catch (error) {
    throw toParseError("LLM experience extraction response is not valid JSON.", error, raw);
  }

  const validation = validateWithSchema(LLMExperienceExtractionOutputSchema, parsed);
  if (!validation.ok) {
    throw new LLMExperienceExtractionParseError(
      `LLM experience extraction schema validation failed: ${validation.errors.join("; ")}`,
      validation.errors.join("; "),
      preview(raw),
    );
  }
  return validation.data;
}

function toParseError(message: string, error: unknown, raw: string): LLMExperienceExtractionParseError {
  const reason = error instanceof Error ? error.message : String(error);
  return new LLMExperienceExtractionParseError(
    `${message} ${reason}`,
    reason,
    preview(raw),
  );
}

function preview(raw: string): string {
  return raw.slice(0, 300);
}
