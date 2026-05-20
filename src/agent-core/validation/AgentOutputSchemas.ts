import { z } from "zod";

export const AgentNameSchema = z.enum([
  "frontdesk",
  "experience_receiver",
  "strategist",
  "architect",
  "critic",
]);

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  agentName: AgentNameSchema,
  toolName: z.string().min(1).optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().min(1),
});

export const AgentDecisionSchema = z.object({
  agentName: AgentNameSchema,
  responseType: z.enum(["route", "plan", "final", "ask_clarification", "error"]),
  routeTo: AgentNameSchema.optional(),
  assistantMessage: z.string().default(""),
  plan: z.array(PlanStepSchema).default([]),
  missingInputs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
});

export type AgentName = z.infer<typeof AgentNameSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export function invalidAgentOutputDecision(agentName: AgentName): AgentDecision {
  return {
    agentName,
    responseType: "error",
    assistantMessage: "I could not produce a valid plan for this request.",
    plan: [],
    missingInputs: [],
    confidence: 0,
  };
}
