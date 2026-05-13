import type { ToolDefinition } from "../core/tool/types.js";

export const getCurrentTimeTool: ToolDefinition = {
  name: "getCurrentTime",
  description: "Return the current time as an ISO 8601 string.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(): Promise<unknown> {
    return {
      iso: new Date().toISOString()
    };
  }
};
