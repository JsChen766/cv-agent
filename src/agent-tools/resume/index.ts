import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { createAcceptGenerationVariantTool } from "./acceptGenerationVariant.tool.js";
import { createGenerateResumeFromJDTool } from "./generateResumeFromJD.tool.js";
import { createGetResumeTool } from "./getResume.tool.js";
import { createListResumesTool } from "./listResumes.tool.js";
import { createPrepareReviseResumeItemTool } from "./prepareReviseResumeItem.tool.js";
import { createReviseResumeItemTool } from "./reviseResumeItem.tool.js";

export { toWorkspaceVariant } from "./helpers.js";

export function createResumeAgentTools(): ToolDefinition[] {
  return [
    createListResumesTool(),
    createGetResumeTool(),
    createGenerateResumeFromJDTool(),
    createAcceptGenerationVariantTool(),
    createPrepareReviseResumeItemTool(),
    createReviseResumeItemTool(),
  ];
}
