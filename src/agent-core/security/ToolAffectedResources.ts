import type { PendingAction } from "../confirmation/PendingAction.js";
import {
  isCanonicalExperienceId,
  isCanonicalJDId,
  isCanonicalResumeId,
} from "../../copilot/context/IdGuards.js";

export function affectedResourcesFor(toolName: string, args: Record<string, unknown>): PendingAction["affectedResources"] {
  if (toolName.includes("experience")) {
    const rawId = stringValue(args.experienceId) ?? stringValue(args.id);
    const id = isCanonicalExperienceId(rawId) ? rawId : undefined;
    return id ? [{ type: "experience", id }] : [];
  }
  if (toolName.includes("jd")) {
    const rawId = stringValue(args.jdId) ?? stringValue(args.id);
    const id = isCanonicalJDId(rawId) ? rawId : undefined;
    return id ? [{ type: "jd", id }] : [];
  }
  if (toolName.includes("resume")) {
    const rawId = stringValue(args.resumeId) ?? stringValue(args.id);
    const id = isCanonicalResumeId(rawId) ? rawId : undefined;
    return id ? [{ type: "resume", id }] : [];
  }
  if (toolName.includes("export")) return [{ type: "export" }];
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
