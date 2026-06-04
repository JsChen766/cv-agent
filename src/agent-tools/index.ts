import type { ToolDefinition } from "../agent-core/tools/Tool.js";
import { careerDomain } from "../agent-domains/career/index.js";

export function createAgentTools(): ToolDefinition[] {
  return [...(careerDomain.tools ?? [])];
}
