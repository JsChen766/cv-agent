import type {
  EvaluationCriticReview,
  EvaluationHook,
  EvaluationRunInput,
  EvaluationRunOutput,
  EvaluationToolResult,
} from "./EvaluationHook.js";

export class NoopEvaluationHook implements EvaluationHook {
  public readonly id = "core.noop.evaluation";

  public async beforeRun(_input: EvaluationRunInput): Promise<void> {}

  public async afterRun(_output: EvaluationRunOutput): Promise<void> {}

  public async onToolResult(_result: EvaluationToolResult): Promise<void> {}

  public async onCriticReview(_review: EvaluationCriticReview): Promise<void> {}
}
