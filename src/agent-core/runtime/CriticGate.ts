import { z } from "zod";
import type { Agent } from "../agents/BaseAgent.js";
import { getAgentDecisionMeta } from "../agents/BaseAgent.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";
import type { AgentMessageBus } from "./AgentMessageBus.js";
import type { AgentContext } from "./AgentContext.js";
import type { AgentTraceRecorder } from "./AgentTrace.js";

const CRITIC_TOOL_NAMES = new Set([
  "generate_resume_from_jd",
  "revise_resume_item",
  "save_experience_from_text",
  "update_experience",
]);

const CriticReviewSchema = z.object({
  verdict: z.enum(["pass", "needs_revision", "blocked", "needs_user_confirmation"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  unsupportedClaims: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  suggestedFixes: z.array(z.string()).default([]),
  userVisibleSummary: z.string().default("Review completed."),
});

export type CriticReview = z.infer<typeof CriticReviewSchema>;

export type ToolExecutionRecord = {
  step: PlanStep;
  result: ToolResult;
};

export type CriticGateResult = {
  status: "skipped" | CriticReview["verdict"];
  review?: CriticReview;
  criticToolResults: ToolResult[];
};

export class CriticGate {
  public constructor(
    private readonly deps: {
      critic: Agent;
      messageBus: AgentMessageBus;
      trace: AgentTraceRecorder;
      executeCriticPlan(plan: PlanStep[]): Promise<ToolExecutionRecord[]>;
    },
  ) {}

  public async review(input: {
    context: AgentContext;
    toolExecutions: ToolExecutionRecord[];
    sourceAgent: AgentName;
  }): Promise<CriticGateResult> {
    const reviewTargets = input.toolExecutions.filter((execution) => shouldReview(execution));
    if (reviewTargets.length === 0) return { status: "skipped", criticToolResults: [] };

    const message = this.deps.messageBus.requestReview(input.sourceAgent, "critic", {
      toolResults: reviewTargets.map(summarizeExecution),
    });
    input.context.agentMessages = this.deps.messageBus.list();
    this.deps.trace.add({
      agentName: "AgentOrchestrator",
      type: "reason",
      summary: "Requested critic review for high-impact tool results.",
      status: "success",
      completedAt: new Date().toISOString(),
      metadata: { messageId: message.id, toolNames: reviewTargets.map((item) => item.step.toolName) },
    });

    const criticResults: ToolResult[] = [];
    let decision = await this.deps.critic.decide({
      context: input.context,
      routeHint: "critic",
      task: "Review the recent generated or modified result. Return a CriticReview-compatible JSON object in criticReview.",
    });
    let review = extractReview(decision);

    if (!review && decision.plan.length > 0) {
      const executions = await this.deps.executeCriticPlan(decision.plan);
      criticResults.push(...executions.map((execution) => execution.result));
      decision = await this.deps.critic.decide({
        context: input.context,
        routeHint: "critic",
        task: "Use the observations from your review tools and return the final CriticReview-compatible JSON object in criticReview.",
      });
      review = extractReview(decision);
    }

    review ??= conservativePassReview(decision.assistantMessage);
    this.deps.trace.add({
      agentName: "critic",
      type: "reason",
      summary: `Critic verdict: ${review.verdict}.`,
      status: review.verdict === "blocked" ? "failed" : "success",
      completedAt: new Date().toISOString(),
      metadata: { review },
    });
    return { status: review.verdict, review, criticToolResults: criticResults };
  }
}

function shouldReview(execution: ToolExecutionRecord): boolean {
  return execution.result.status === "success" && Boolean(execution.step.toolName && CRITIC_TOOL_NAMES.has(execution.step.toolName));
}

function extractReview(decision: unknown): CriticReview | undefined {
  const meta = getAgentDecisionMeta(decision);
  const raw = meta?.rawOutput;
  return parseReview(raw) ?? parseReview(readObject(raw, "criticReview")) ?? parseReview(readObject(decision, "criticReview")) ?? parseAssistantMessage(decision);
}

function parseAssistantMessage(decision: unknown): CriticReview | undefined {
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) return undefined;
  const message = (decision as { assistantMessage?: unknown }).assistantMessage;
  if (typeof message !== "string") return undefined;
  try {
    return parseReview(JSON.parse(message));
  } catch {
    return undefined;
  }
}

function parseReview(value: unknown): CriticReview | undefined {
  const result = CriticReviewSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function readObject(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function conservativePassReview(message: string): CriticReview {
  return {
    verdict: "pass",
    riskLevel: "low",
    unsupportedClaims: [],
    missingEvidence: [],
    suggestedFixes: [],
    userVisibleSummary: message || "Review completed without blocking issues.",
  };
}

function summarizeExecution(execution: ToolExecutionRecord): Record<string, unknown> {
  return {
    stepId: execution.step.id,
    toolName: execution.step.toolName,
    status: execution.result.status,
    message: execution.result.message,
    data: summarizeData(execution.result.data),
  };
}

function summarizeData(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value.slice(0, 1000);
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}...` : value;
  } catch {
    return "[unserializable]";
  }
}
