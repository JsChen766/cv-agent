import type { ToolDefinition } from "../agent-core/tools/Tool.js";
import { createEvidenceAgentTools } from "./evidence/index.js";
import { createExperienceAgentTools } from "./experience/index.js";
import { createExportAgentTools } from "./export/index.js";
import { createJDAgentTools } from "./jd/index.js";
import { createResumeAgentTools } from "./resume/index.js";

export function createAgentTools(): ToolDefinition[] {
  return [
    ...createExperienceAgentTools(),
    ...createJDAgentTools(),
    ...createResumeAgentTools(),
    ...createExportAgentTools(),
    ...createEvidenceAgentTools(),
  ];
}
