import type { z } from "zod";
import type { AgentContext } from "../runtime/AgentContext.js";
import type { ToolMutability, ToolOwnerAgent, ToolRiskLevel } from "./ToolPermissions.js";
import type { ToolResult } from "./ToolResult.js";

export type ToolDefinition = {
  name: string;
  description: string;
  ownerAgent: ToolOwnerAgent;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  mutability: ToolMutability;
  requiresConfirmation: boolean;
  riskLevel: ToolRiskLevel;
  execute(input: Record<string, unknown>, context: AgentContext): Promise<ToolResult>;
};
