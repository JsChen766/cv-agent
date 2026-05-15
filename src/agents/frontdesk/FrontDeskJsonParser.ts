import { parseAgentJson } from "../../core/json/index.js";
import {
  validateWithSchema,
} from "../../knowledge/schemas/validate.js";
import {
  FrontDeskDecisionSchema,
  type FrontDeskDecision,
} from "../FrontDeskAgent.js";

export class FrontDeskDecisionParseError extends Error {
  public constructor(
    message: string,
    public readonly reason: string,
    public readonly rawPreview: string,
  ) {
    super(message);
    this.name = "FrontDeskDecisionParseError";
  }
}

export function parseFrontDeskDecision(raw: string): FrontDeskDecision {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(raw, { expectedRoot: "object" });
  } catch (error) {
    throw toParseError("FrontDeskAgent response is not valid JSON.", error, raw);
  }

  const validation = validateWithSchema(FrontDeskDecisionSchema, parsed);
  if (!validation.ok) {
    throw new FrontDeskDecisionParseError(
      `FrontDeskAgent decision schema validation failed: ${validation.errors.join("; ")}`,
      validation.errors.join("; "),
      preview(raw),
    );
  }

  return validation.data;
}

function toParseError(message: string, error: unknown, raw: string): FrontDeskDecisionParseError {
  const reason = error instanceof Error ? error.message : String(error);
  return new FrontDeskDecisionParseError(
    `${message} ${reason}`,
    reason,
    preview(raw),
  );
}

function preview(raw: string): string {
  return raw.slice(0, 300);
}
