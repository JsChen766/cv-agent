import { AgentError } from "../runtime/AgentError.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";

export class PlanValidator {
  public constructor(private readonly registry: ToolRegistry) {}

  public validate(steps: PlanStep[], agentName: AgentName, allowedTools: string[]): PlanStep[] {
    for (const step of steps) {
      if (step.agentName !== agentName) {
        throw new AgentError("INVALID_AGENT_OUTPUT", "Plan step agent mismatch.");
      }
      if (step.toolName) {
        if (!allowedTools.includes(step.toolName)) {
          throw new AgentError("TOOL_NOT_FOUND", `Tool is not allowed for ${agentName}.`, { statusCode: 403 });
        }
        if (!this.registry.has(step.toolName)) {
          throw new AgentError("TOOL_NOT_FOUND", "Planned tool is not registered.", { statusCode: 404 });
        }
      }
    }
    return steps;
  }
}
