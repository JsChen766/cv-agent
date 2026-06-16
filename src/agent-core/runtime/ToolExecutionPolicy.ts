import type { ToolDefinition } from "../tools/Tool.js";

export class ToolExecutionPolicy {
  public canExecuteWithoutConfirmation(
    tool: Pick<ToolDefinition, "requiresConfirmation">,
    autoRevisionAuthorized: boolean,
  ): boolean {
    return !tool.requiresConfirmation || autoRevisionAuthorized;
  }
}
