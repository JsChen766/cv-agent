import type {
  CopilotActionRequest,
  CopilotWorkspace,
  ProductAction,
} from "../../copilot/types.js";
import type { CopilotActivityType } from "../../copilot/persistence/index.js";
import type { AgentDecision } from "../schema/AgentDecision.js";
import type { AgentToolResult } from "../tools/AgentToolRegistry.js";

export function mergeWorkspace(
  sessionId: string,
  existing: CopilotWorkspace | null,
  decision: AgentDecision,
  results: AgentToolResult[],
): CopilotWorkspace {
  const base: CopilotWorkspace = existing ?? {
    id: `ws-${sessionId}`,
    sessionId,
    variants: [],
    status: "empty",
    updatedAt: new Date().toISOString(),
  };
  const workspace = { ...base };
  for (const result of results) {
    if (!result.workspacePatch) continue;
    Object.assign(workspace, result.workspacePatch);
    workspace.variants = result.workspacePatch.variants ?? workspace.variants ?? [];
  }
  if (decision.workspaceIntent?.activePanel && isPanel(decision.workspaceIntent.activePanel)) {
    workspace.activePanel = decision.workspaceIntent.activePanel;
  }
  workspace.updatedAt = new Date().toISOString();
  return workspace;
}

export function activityTypeForDecision(decision: AgentDecision, results: AgentToolResult[]): CopilotActivityType {
  const toolNames = new Set(decision.toolCalls?.map((call) => call.toolName) ?? []);
  if (toolNames.has("generate_resume_variants")) return "generation";
  if (toolNames.has("revise_variant")) return "revision";
  if (toolNames.has("save_variant_to_resume")) return "save_resume";
  if (toolNames.has("record_variant_decision")) return "decision";
  if (toolNames.has("import_resume_text")) return "import";
  if (toolNames.has("create_experience")) return "save_experience";
  if (results.some((result) => result.workspacePatch?.activePanel === "variants")) return "generation";
  return "chat";
}

export function activityTitle(type: CopilotActivityType): string {
  switch (type) {
    case "generation": return "Generated resume variants";
    case "revision": return "Revised a variant";
    case "decision": return "Recorded a variant decision";
    case "import": return "Imported resume text";
    case "save_experience": return "Saved an experience";
    case "save_resume": return "Saved a variant to resume";
    default: return "Copilot chat";
  }
}

export function toolForAction(type: ProductAction["type"]): string {
  switch (type) {
    case "revise_more_conservative":
    case "revise_more_quantified":
      return "revise_variant";
    case "show_evidence":
      return "show_evidence";
    case "explain_choice":
      return "explain_choice";
    case "accept":
      return "save_variant_to_resume";
    case "reject":
    case "prefer":
    case "confirm_metric":
      return "record_variant_decision";
  }
}

export function argsForAction(
  action: CopilotActionRequest["action"],
  workspace: CopilotWorkspace | null,
): Record<string, unknown> {
  const variantId = action.variantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
  if (action.type === "accept") {
    return { generationId: workspace?.productGenerationId, variantId, resumeId: workspace?.resumeId };
  }
  if (action.type === "revise_more_conservative") {
    return { variantId, instruction: "make_more_conservative" };
  }
  if (action.type === "revise_more_quantified") {
    return { variantId, instruction: "make_more_quantified" };
  }
  if (action.type === "show_evidence" || action.type === "explain_choice") {
    return { variantId };
  }
  return { variantId, decision: action.type, payload: action.payload };
}

function isPanel(value: string): value is NonNullable<CopilotWorkspace["activePanel"]> {
  return ["variants", "experience_library", "resume_history", "resume_editor", "jd_library", "import_candidates"].includes(value);
}
