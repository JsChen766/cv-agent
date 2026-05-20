import type { ToolDefinition } from "../tools/Tool.js";

export class ConfirmationPolicy {
  public requiresConfirmation(tool: ToolDefinition): boolean {
    return tool.requiresConfirmation || tool.mutability === "write" || tool.mutability === "delete" || tool.mutability === "export";
  }
}
