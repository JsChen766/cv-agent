import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { composeCareerTextTool } from "./composeCareerText.tool.js";

/**
 * Phase 2 writing-tool barrel.
 *
 * Exposes asset-grounded read-only writing tools. Phase 2 only registers
 * `compose_career_text`; Phase 3+ may add more cohesive variants here.
 */
export function createWritingAgentTools(): ToolDefinition[] {
  return [composeCareerTextTool()];
}

export { composeCareerTextTool };
