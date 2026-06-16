import { randomUUID } from "node:crypto";
import type { ProductActionType } from "../../copilot/types.js";
import type { EvaluationHook } from "../evaluation/EvaluationHook.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { PlanStep } from "../validation/AgentOutputSchemas.js";
import type { AgentContext } from "../runtime/AgentContext.js";
import type { CriticGateResult } from "../runtime/CriticGate.js";
import type { LearningEvent, LearningEventType } from "./LearningEvent.js";
import { LearningEventRecorder } from "./LearningEventRecorder.js";

export type LearningEventServiceDeps = {
  recorder?: LearningEventRecorder;
  evaluationHooks?: readonly EvaluationHook[];
  now?: () => Date;
};

type LearningEventContext = {
  userId: string;
  sessionId?: string;
  turnId?: string;
};

export class LearningEventService {
  private readonly recorder: LearningEventRecorder;
  private readonly evaluationHooks: readonly EvaluationHook[];
  private readonly now: () => Date;

  public constructor(deps: LearningEventServiceDeps = {}) {
    this.recorder = deps.recorder ?? new LearningEventRecorder();
    this.evaluationHooks = deps.evaluationHooks ?? [];
    this.now = deps.now ?? (() => new Date());
  }

  public async recordToolResult(context: AgentContext, step: PlanStep, result: ToolResult): Promise<void> {
    const type = learningEventTypeForToolResult(step.toolName, result);
    await this.record(context, type, "plan_execution_service", {
      stepId: step.id,
      agentName: step.agentName,
      toolName: step.toolName,
      status: result.status,
      actionType: stringValue(result.actionResult?.actionType),
      pendingActionId: result.pendingActionId ?? stringValue(result.actionResult?.pendingActionId),
    });
    await Promise.allSettled(this.evaluationHooks.map((hook) => hook.onToolResult?.({
      toolName: step.toolName,
      status: result.status,
      metadata: {
        stepId: step.id,
        agentName: step.agentName,
        actionType: stringValue(result.actionResult?.actionType),
      },
    })));
  }

  public async recordPendingActionCreated(context: AgentContext, action: PendingAction, step?: PlanStep): Promise<void> {
    await this.record(context, "pending_action.created", "plan_execution_service", {
      pendingActionId: action.id,
      toolName: action.toolName,
      riskLevel: action.riskLevel,
      affectedResourceTypes: action.affectedResources.map((resource) => resource.type),
      stepId: step?.id,
      agentName: step?.agentName,
    });
  }

  public async recordPendingActionConfirmed(context: AgentContext, action: PendingAction, result: ToolResult): Promise<void> {
    await this.record(context, "pending_action.confirmed", "agent_orchestrator", {
      pendingActionId: action.id,
      toolName: action.toolName,
      status: result.status,
      actionType: stringValue(result.actionResult?.actionType),
    });
  }

  public async recordPendingActionCancelled(action: PendingAction): Promise<void> {
    await this.record({
      userId: action.userId,
      sessionId: action.sessionId,
      turnId: action.turnId,
    }, "pending_action.cancelled", "agent_orchestrator", {
      pendingActionId: action.id,
      toolName: action.toolName,
      status: action.status,
    });
  }

  public async recordCriticReview(context: AgentContext, result: CriticGateResult): Promise<void> {
    const type = learningEventTypeForCriticResult(result.status);
    if (!type) return;
    await this.record(context, type, "review_pipeline", {
      status: result.status,
      verdict: result.review?.verdict,
      riskLevel: result.review?.riskLevel,
    });
  }

  public async recordExplicitAction(context: AgentContext, actionType: ProductActionType, payload?: Record<string, unknown>): Promise<void> {
    const type = learningEventTypeForExplicitAction(actionType);
    if (!type) return;
    await this.record(context, type, "explicit_action", {
      actionType,
      variantId: stringValue(payload?.variantId),
      generationId: stringValue(payload?.generationId),
    });
  }

  private async record(
    context: LearningEventContext,
    type: LearningEventType,
    source: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const event: LearningEvent = {
      id: `le-${randomUUID()}`,
      type,
      userId: context.userId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      source,
      payload,
      createdAt: this.now().toISOString(),
    };
    try {
      await this.recorder.record(event);
    } catch {
      // Learning events are internal telemetry and must never affect a user flow.
    }
  }
}

function learningEventTypeForToolResult(toolName: string | undefined, result: ToolResult): LearningEventType {
  const actionType = stringValue(result.actionResult?.actionType) ?? toolName;
  if (result.status === "failed") return "tool.failed";
  if (result.status === "needs_input") return "tool.needs_input";
  if (actionType === "save_experience_from_text") return "experience.saved";
  if (actionType === "update_experience") return "experience.updated";
  if (actionType === "save_jd_from_text") return "jd.saved";
  if (actionType === "generate_resume_from_jd") return "resume.generated";
  if (actionType === "accept_generation_variant") return "variant.accepted";
  if (actionType === "export_resume") return "export.completed";
  return "tool.succeeded";
}

function learningEventTypeForCriticResult(status: CriticGateResult["status"]): LearningEventType | undefined {
  if (status === "pass") return "critic.passed";
  if (status === "needs_revision") return "critic.needs_revision";
  if (status === "blocked") return "critic.blocked";
  if (status === "needs_user_confirmation") return "critic.needs_user_confirmation";
  return undefined;
}

function learningEventTypeForExplicitAction(actionType: ProductActionType): LearningEventType | undefined {
  if (actionType === "accept") return "user.preference_signal";
  if (actionType === "reject") return "variant.rejected";
  if (actionType === "prefer") return "user.preference_signal";
  if (actionType === "confirm_metric") return "user.preference_signal";
  if (actionType === "revise_more_conservative") return "user.preference_signal";
  if (actionType === "revise_more_quantified") return "user.preference_signal";
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
