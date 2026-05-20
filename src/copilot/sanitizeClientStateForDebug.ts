import type { CopilotClientState } from "./types.js";

const DEBUG_CLIENT_STATE_KEYS = [
  "mainMode",
  "activeJDId",
  "activeResumeId",
  "activeExperienceId",
  "activeVariantId",
  "activeResumeItemId",
  "activeImportJobId",
  "activeCandidateIds",
  "selectedSection",
  "visibleArtifactTypes",
  "visibleArtifactIds",
  "intentSource",
  "sourceComponent",
] as const;

export function sanitizeClientStateForDebug(clientState: CopilotClientState | undefined): Record<string, unknown> {
  if (!clientState) return {};

  const sanitized: Record<string, unknown> = {};
  for (const key of DEBUG_CLIENT_STATE_KEYS) {
    const value = clientState[key];
    const debugValue = sanitizeDebugValue(value);
    if (debugValue !== undefined) {
      sanitized[key] = debugValue;
    }
  }

  if (typeof clientState.selectedText === "string") {
    sanitized.selectedText = clientState.selectedText.slice(0, 300);
    sanitized.selectedTextLength = clientState.selectedText.length;
  }

  return sanitized;
}

function sanitizeDebugValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .slice(0, 50)
      .map((item) => item.slice(0, 300));
  }
  return undefined;
}
