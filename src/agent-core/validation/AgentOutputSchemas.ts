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

export const CriticReviewSchema = z.object({
  verdict: z.enum(["pass", "needs_revision", "blocked", "needs_user_confirmation"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  unsupportedClaims: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  suggestedFixes: z.array(z.string()),
  userVisibleSummary: z.string(),
});

export const AgentDecisionSchema = z.object({
  agentName: AgentNameSchema,
  responseType: z.enum(["route", "plan", "final", "ask_clarification", "error"]),
  routeTo: AgentNameSchema.optional(),
  assistantMessage: z.string().default(""),
  plan: z.array(PlanStepSchema).default([]),
  missingInputs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
  criticReview: CriticReviewSchema.optional(),
});

export type AgentName = z.infer<typeof AgentNameSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type CriticReview = z.infer<typeof CriticReviewSchema>;
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

  const agentNameOk =
    typeof obj.agentName === "string" && AgentNames.includes(obj.agentName as AgentName)
      ? (obj.agentName as AgentName)
      : agentName;

  const validResponseTypes = ["route", "plan", "final", "ask_clarification", "error"];
  const responseTypeOk =
    typeof obj.responseType === "string" && validResponseTypes.includes(obj.responseType)
      ? (obj.responseType as AgentDecision["responseType"])
      : "ask_clarification";

  const assistantMessageOk =
    typeof obj.assistantMessage === "string" && obj.assistantMessage.trim().length > 0
      ? obj.assistantMessage.trim()
      : "我来处理你的请求。";

  const routeToOk =
    typeof obj.routeTo === "string" && AgentNames.includes(obj.routeTo as AgentName)
      ? (obj.routeTo as AgentName)
      : undefined;

  const planOk: PlanStep[] = Array.isArray(obj.plan)
    ? (obj.plan as unknown[]).map((step, index) => repairPlanStep(step, index, agentNameOk))
    : [];

  const missingInputsOk: string[] = Array.isArray(obj.missingInputs)
    ? (obj.missingInputs as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const conf = Number(obj.confidence);
  const confidenceOk =
    typeof obj.confidence === "number" && !Number.isNaN(conf) && conf >= 0 && conf <= 1
      ? conf
      : 0.5;

  const repaired: AgentDecision = {
    agentName: agentNameOk,
    responseType: responseTypeOk,
    assistantMessage: assistantMessageOk,
    plan: planOk,
    missingInputs: missingInputsOk,
    confidence: confidenceOk,
  };
  if (routeToOk) repaired.routeTo = routeToOk;
  const criticReview = CriticReviewSchema.safeParse(obj.criticReview);
  if (criticReview.success) repaired.criticReview = criticReview.data;

  const result = AgentDecisionSchema.safeParse(repaired);
  if (result.success) return result.data;
  return null;
}

function repairPlanStep(raw: unknown, index: number, agentName: AgentName): PlanStep {
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

  const idOk =
    typeof step.id === "string" && step.id.trim().length > 0
      ? step.id.trim()
      : `step-${index + 1}`;

  const agentNameOk =
    typeof step.agentName === "string" && AgentNames.includes(step.agentName as AgentName)
      ? (step.agentName as AgentName)
      : agentName;

  const toolNameOk =
    step.toolName === undefined || typeof step.toolName === "string"
      ? (step.toolName as string | undefined)
      : undefined;

  const argsOk =
    typeof step.arguments === "object" && step.arguments !== null
      ? (step.arguments as Record<string, unknown>)
      : {};

  const summaryOk =
    typeof step.summary === "string" && step.summary.trim().length > 0
      ? step.summary.trim()
      : `Auto-repaired plan step ${index + 1}.`;

  return {
    id: idOk,
    agentName: agentNameOk,
    toolName: toolNameOk,
    arguments: argsOk,
    summary: summaryOk,
  };
}

export function isAgentDecision(value: unknown): value is AgentDecision {
  return AgentDecisionSchema.safeParse(value).success;
}
