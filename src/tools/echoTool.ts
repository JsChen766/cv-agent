import type { ToolDefinition } from "../core/tool/types.js";

export const echoTool: ToolDefinition = {
  name: "echo",
  description: "Return the provided message unchanged.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Message to echo."
      }
    },
    required: ["message"],
    additionalProperties: false
  },
  async execute(args: unknown): Promise<unknown> {
    const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
    return {
      message: typeof record.message === "string" ? record.message : ""
    };
  }
};
