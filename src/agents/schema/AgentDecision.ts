import { z } from "zod";

export const AgentToolCallSchema = z.object({
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const SuggestedPromptSchema = z.object({
  label: z.string().min(1),
  message: z.string().min(1),
});

export const AgentDecisionSchema = z.object({
  mode: z.enum([
    "respond",
    "ask_clarification",
    "call_tool",
    "call_tools",
    "generate",
    "revise",
    "explain_workspace",
  ]),
  assistantMessage: z.string().min(1),
  toolCalls: z.array(AgentToolCallSchema).optional(),
  missingInputs: z.array(z.string()).optional(),
  workspaceIntent: z.object({
    activePanel: z.string().optional(),
    focusEntityType: z.string().optional(),
    focusEntityId: z.string().optional(),
  }).optional(),
  suggestedPrompts: z.array(SuggestedPromptSchema).optional(),
  confidence: z.number().min(0).max(1),
});

export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export function safeClarificationDecision(message = "我刚才没有理解清楚，可以换种说法或补充你想做的事情吗？"): AgentDecision {
  return {
    mode: "ask_clarification",
    assistantMessage: message,
    missingInputs: ["intent"],
    confidence: 0,
  };
}
