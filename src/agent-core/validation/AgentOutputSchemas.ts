import { z } from "zod";

export const AgentNameSchema = z.enum([
  "frontdesk",
  "experience_receiver",
  "strategist",
  "architect",
  "critic",
]);

export const AgentNames: readonly AgentName[] = AgentNameSchema.options;

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
    responseType: "ask_clarification",
    assistantMessage: "我理解了你的请求，但刚才没有生成可执行计划。请稍微换种说法，或者告诉我是要查看、保存、修改还是生成。",
    plan: [],
    missingInputs: [],
    confidence: 0.3,
  };
}

export function repairAgentDecision(raw: unknown, agentName: AgentName): AgentDecision | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Ensure agentName
  if (typeof obj.agentName !== "string" || !AgentNames.includes(obj.agentName as AgentName)) {
    obj.agentName = agentName;
  }

  // Ensure responseType
  const validResponseTypes = ["route", "plan", "final", "ask_clarification", "error"];
  if (typeof obj.responseType !== "string" || !validResponseTypes.includes(obj.responseType)) {
    obj.responseType = "ask_clarification";
  }

  // Ensure assistantMessage
  if (typeof obj.assistantMessage !== "string" || obj.assistantMessage.trim().length === 0) {
    obj.assistantMessage = "我来处理你的请求。";
  }

  // Ensure plan is an array
  if (!Array.isArray(obj.plan)) {
    obj.plan = [];
  }

  // Repair each plan step
  obj.plan = (obj.plan as unknown[]).map((step, index) => repairPlanStep(step, index, agentName));

  // Ensure missingInputs
  if (!Array.isArray(obj.missingInputs)) {
    obj.missingInputs = [];
  }

  // Ensure confidence
  const conf = Number(obj.confidence);
  if (typeof obj.confidence !== "number" || Number.isNaN(conf) || conf < 0 || conf > 1) {
    obj.confidence = 0.5;
  }

  // Validate with schema
  const result = AgentDecisionSchema.safeParse(obj);
  if (result.success) return result.data;

  // If still invalid, build a clean fallback manually
  return null;
}

function repairPlanStep(raw: unknown, index: number, agentName: AgentName): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    return {
      id: `step-${index + 1}`,
      agentName,
      toolName: undefined,
      arguments: {},
      summary: "Auto-repaired step.",
    };
  }
  const step = raw as Record<string, unknown>;

  if (typeof step.id !== "string" || step.id.trim().length === 0) {
    step.id = `step-${index + 1}`;
  }

  if (typeof step.agentName !== "string" || !AgentNames.includes(step.agentName as AgentName)) {
    step.agentName = agentName;
  }

  if (typeof step.arguments !== "object" || step.arguments === null) {
    step.arguments = {};
  }

  if (typeof step.summary !== "string" || step.summary.trim().length === 0) {
    step.summary = `Auto-repaired plan step ${index + 1}.`;
  }

  if (step.toolName !== undefined && typeof step.toolName !== "string") {
    step.toolName = undefined;
  }

  return step;
}

export function isAgentDecision(value: unknown): value is AgentDecision {
  return AgentDecisionSchema.safeParse(value).success;
}
