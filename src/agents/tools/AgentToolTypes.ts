import type { z } from "zod";
import type { KernelRequestContext } from "../../kernel/context.js";
import type {
  CopilotChatRequest,
  CopilotActionResult,
  CopilotSession,
  CopilotWorkspace,
  ProductAction,
  ProductTimelineItem,
  SuggestedPrompt,
} from "../../copilot/types.js";

export type AgentToolStatus = "success" | "needs_input" | "failed";

export type AgentToolResult = {
  status: AgentToolStatus;
  assistantMessage?: string;
  workspacePatch?: Partial<CopilotWorkspace>;
  timelineItems?: ProductTimelineItem[];
  rawIds?: {
    artifactIds?: string[];
    evidenceChainIds?: string[];
    critiqueItemIds?: string[];
    decisionIds?: string[];
  };
  raw?: Record<string, unknown>;
  actionResult?: CopilotActionResult;
  nextActions?: ProductAction[];
  suggestedPrompts?: SuggestedPrompt[];
};

export type AgentToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentToolExecutionContext = {
  ctx: KernelRequestContext;
  session: CopilotSession;
  workspace?: CopilotWorkspace | null;
  request: CopilotChatRequest;
  turnId: string;
};

export type AgentToolDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: TArgs;
  jsonSchema: Record<string, unknown>;
  execute(args: any, context: AgentToolExecutionContext): Promise<AgentToolResult>;
};
