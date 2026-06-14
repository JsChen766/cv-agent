import { randomUUID } from "node:crypto";
import type { EvaluationHook } from "../evaluation/EvaluationHook.js";
import { defaultReviewPolicy, type ReviewPolicy } from "../evaluation/ReviewPolicy.js";
import type { LearningEvent } from "../reflection/LearningEvent.js";
import { LearningEventRecorder } from "../reflection/LearningEventRecorder.js";
import type { AgentName } from "../validation/AgentOutputSchemas.js";
import type { AgentContext } from "./AgentContext.js";
import type { CriticGate, CriticGateResult, ToolExecutionRecord } from "./CriticGate.js";

type ReviewPipelineDeps = {
  reviewPolicy?: ReviewPolicy;
  createCriticGate: () => CriticGate;
  evaluationHooks?: readonly EvaluationHook[];
  learningEventRecorder?: LearningEventRecorder;
};

export type ReviewPipelineInput = {
  context: AgentContext;
  toolExecutions: ToolExecutionRecord[];
  sourceAgent: AgentName;
};

export class ReviewPipeline {
  private readonly reviewPolicy: ReviewPolicy;
  private readonly evaluationHooks: readonly EvaluationHook[];
  private readonly learningEventRecorder: LearningEventRecorder;

  public constructor(private readonly deps: ReviewPipelineDeps) {
    this.reviewPolicy = deps.reviewPolicy ?? defaultReviewPolicy;
    this.evaluationHooks = deps.evaluationHooks ?? [];
    this.learningEventRecorder = deps.learningEventRecorder ?? new LearningEventRecorder();
  }

  public shouldReviewTool(toolName: string): boolean {
    return this.reviewPolicy.shouldReviewTool(toolName);
  }

  public shouldReviewExecutions(executions: readonly ToolExecutionRecord[]): boolean {
    return this.reviewPolicy.shouldReviewExecutions(executions);
  }

  public async review(input: ReviewPipelineInput): Promise<CriticGateResult> {
    if (!this.shouldReviewExecutions(input.toolExecutions)) {
      return { status: "skipped", criticToolResults: [] };
    }

    const result = await this.deps.createCriticGate().review(input);
    await this.emitCriticReview(input.context, result);
    await this.recordLearningEvent(input.context, result);
    return result;
  }

  private async emitCriticReview(context: AgentContext, result: CriticGateResult): Promise<void> {
    if (!result.review) return;
    await Promise.allSettled(this.evaluationHooks.map((hook) => hook.onCriticReview?.({
      verdict: result.review?.verdict,
      riskLevel: result.review?.riskLevel,
      metadata: {
        sessionId: context.sessionId,
        turnId: context.turnId,
        status: result.status,
      },
    })));
  }

  private async recordLearningEvent(context: AgentContext, result: CriticGateResult): Promise<void> {
    const type = learningEventTypeFor(result.status);
    if (!type) return;
    const event: LearningEvent = {
      id: `le-${randomUUID()}`,
      type,
      userId: context.userId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      source: "review_pipeline",
      payload: {
        verdict: result.review?.verdict,
        riskLevel: result.review?.riskLevel,
      },
      createdAt: new Date().toISOString(),
    };
    await this.learningEventRecorder.record(event);
  }
}

function learningEventTypeFor(status: CriticGateResult["status"]): LearningEvent["type"] | undefined {
  if (status === "needs_revision") return "critic.needs_revision";
  if (status === "blocked") return "critic.blocked";
  if (status === "needs_user_confirmation") return "critic.needs_user_confirmation";
  return undefined;
}
