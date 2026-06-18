import { randomUUID } from "node:crypto";
import type { CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";
import type { CopilotTask } from "./CopilotTask.js";

export function tasksFromHandoff(
  workspace: CopilotWorkspace | null,
  handoff: FrontDeskHandoff,
  now: string,
): Pick<CopilotWorkspace, "currentTask" | "suggestedTasks"> {
  const refs = {
    jdId: handoff.extracted.jdId ?? workspace?.active?.jdId ?? workspace?.jdId ?? undefined,
    jdDraftId: workspace?.active?.jdDraftId,
    experienceId: handoff.extracted.experienceId ?? workspace?.active?.experienceId,
    experienceDraftId: workspace?.active?.experienceDraftId,
    resumeId: handoff.extracted.resumeId ?? workspace?.active?.resumeId ?? workspace?.resumeId ?? undefined,
    resumeItemId: handoff.extracted.resumeItemId ?? workspace?.active?.resumeItemId,
    variantId: handoff.extracted.variantId ?? workspace?.active?.variantId ?? workspace?.activeVariantId ?? undefined,
  };
  if (handoff.intent === "general.chat" || handoff.intent === "clarify") {
    return { suggestedTasks: workspace?.suggestedTasks ?? [] };
  }
  // Phase 1 (asset-grounded writing): the writing flow is read-only and does
  // not mutate workspace state, so it intentionally produces no currentTask.
  // Same for experience.match_against_jd, which the existing
  // match_experiences_against_jd tool models as a transient read-only
  // operation; the workspace already surfaces match_results via toolResults
  // and ProductBlocks. Keeping these intents task-less avoids confusing
  // history rendering with phantom "in-progress" cards.
  if (handoff.intent === "asset_grounded.write" || handoff.intent === "experience.match_against_jd") {
    return { suggestedTasks: workspace?.suggestedTasks ?? [] };
  }
  if (handoff.intent === "jd.intake") {
    return {
      currentTask: makeTask("JD_INTAKE", "completed", "strategist", refs, now),
      suggestedTasks: [
        makeTask("JD_SAVE", "planned", "strategist", refs, now),
        makeTask("JD_ANALYZE", "planned", "strategist", refs, now),
        makeTask("RESUME_GENERATE_FROM_JD", "planned", "architect", refs, now),
      ],
    };
  }
  if (handoff.intent === "resume.generate_from_jd") {
    return {
      currentTask: makeTask("RESUME_GENERATE_FROM_JD", "planned", "architect", refs, now),
      suggestedTasks: [],
    };
  }
  if (handoff.intent === "experience.rewrite") {
    return {
      currentTask: makeTask("EXPERIENCE_REWRITE", handoff.missingInputs?.length ? "needs_input" : "planned", "experience_receiver", refs, now, handoff.missingInputs),
      suggestedTasks: [],
    };
  }
  if (handoff.intent === "experience.intake") {
    return {
      currentTask: makeTask("EXPERIENCE_REWRITE", "planned", "experience_receiver", refs, now),
      suggestedTasks: [
        makeTask("EXPERIENCE_REWRITE", "planned", "experience_receiver", refs, now),
      ],
    };
  }
  return { suggestedTasks: workspace?.suggestedTasks ?? [] };
}

function makeTask(
  type: CopilotTask["type"],
  status: CopilotTask["status"],
  ownerAgent: CopilotTask["ownerAgent"],
  inputRefs: CopilotTask["inputRefs"],
  now: string,
  missingInputs?: string[],
): CopilotTask {
  return {
    id: `task-${randomUUID()}`,
    type,
    status,
    ownerAgent,
    inputRefs,
    missingInputs,
    createdAt: now,
    updatedAt: now,
  };
}
