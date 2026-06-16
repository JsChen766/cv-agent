import type { EvaluationHook } from "../evaluation/EvaluationHook.js";
import { defaultReviewPolicy, type ReviewPolicy } from "../evaluation/ReviewPolicy.js";
import { LearningEventRecorder } from "../reflection/LearningEventRecorder.js";
import { LearningEventService } from "../reflection/LearningEventService.js";
import type { AgentName } from "../validation/AgentOutputSchemas.js";
import type { AgentContext } from "./AgentContext.js";
import type { CriticGate, CriticGateResult, ToolExecutionRecord } from "./CriticGate.js";

type ReviewPipelineDeps = {
  reviewPolicy?: ReviewPolicy;
  createCriticGate: () => CriticGate;
  evaluationHooks?: readonly EvaluationHook[];
  learningEventRecorder?: LearningEventRecorder;
  learningEventService?: LearningEventService;
};

export type ReviewPipelineInput = {
  context: AgentContext;
  toolExecutions: ToolExecutionRecord[];
  sourceAgent: AgentName;
};

export class ReviewPipeline {
  private readonly reviewPolicy: ReviewPolicy;
  private readonly evaluationHooks: readonly EvaluationHook[];
  private readonly learningEventService: LearningEventService;

  public constructor(private readonly deps: ReviewPipelineDeps) {
    this.reviewPolicy = deps.reviewPolicy ?? defaultReviewPolicy;
    this.evaluationHooks = deps.evaluationHooks ?? [];
    this.learningEventService = deps.learningEventService ?? new LearningEventService({
      recorder: deps.learningEventRecorder ?? new LearningEventRecorder(),
      evaluationHooks: this.evaluationHooks,
    });
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
    await this.learningEventService.recordCriticReview(input.context, result);
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

}
