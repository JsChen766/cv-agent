import type { ToolDefinition, ToolSchema } from "./types.js";

export type { JSONSchema, ToolDefinition, ToolExecutionContext, ToolSchema } from "./types.js";

export function toToolSchema(tool: ToolDefinition): ToolSchema {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict })
    }
  };
}
