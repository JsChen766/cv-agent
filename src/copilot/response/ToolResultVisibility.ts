export type ToolResultVisibility =
  | "internal"
  | "user_summary"
  | "action_required"
  | "error_user_visible";

const INTERNAL_TOOL_NAMES = new Set([
  "list_experiences",
  "get_experience",
  "search_experiences",
  "list_jds",
  "get_jd",
  "list_resumes",
  "get_resume",
  "check_unsupported_claims",
  "show_evidence",
]);

export function defaultToolResultVisibility(toolName: string | undefined, status?: string): ToolResultVisibility {
  if (status === "failed") return "error_user_visible";
  if (INTERNAL_TOOL_NAMES.has(toolName ?? "")) return "internal";
  if (toolName?.startsWith("prepare_")) return "action_required";
  return "user_summary";
}
