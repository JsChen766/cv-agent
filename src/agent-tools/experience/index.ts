import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { deleteExperienceTool } from "./deleteExperience.tool.js";
import { getExperienceTool } from "./getExperience.tool.js";
import { listExperiencesTool } from "./listExperiences.tool.js";
import { prepareDeleteExperienceTool } from "./prepareDeleteExperience.tool.js";
import { prepareSaveExperienceFromTextTool } from "./prepareSaveExperienceFromText.tool.js";
import { prepareUpdateExperienceTool } from "./prepareUpdateExperience.tool.js";
import { saveExperienceFromTextTool } from "./saveExperienceFromText.tool.js";
import { searchExperiencesTool } from "./searchExperiences.tool.js";
import { updateExperienceTool } from "./updateExperience.tool.js";

export function createExperienceAgentTools(): ToolDefinition[] {
  return [
    listExperiencesTool(),
    searchExperiencesTool(),
    getExperienceTool(),
    prepareSaveExperienceFromTextTool(),
    saveExperienceFromTextTool(),
    prepareUpdateExperienceTool(),
    updateExperienceTool(),
    prepareDeleteExperienceTool(),
    deleteExperienceTool(),
  ];
}
