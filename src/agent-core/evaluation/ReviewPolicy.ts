import type { ToolExecutionRecord } from "../runtime/CriticGate.js";

const REVIEW_TOOL_NAMES = new Set([
  "generate_resume_from_jd",
  "revise_resume_item",
  "save_experience_from_text",
  "update_experience",
]);

export class ReviewPolicy {
  public shouldReviewTool(toolName: string): boolean {
    return REVIEW_TOOL_NAMES.has(toolName);
  }

  public shouldReviewExecution(execution: ToolExecutionRecord): boolean {
    return execution.result.status === "success"
      && Boolean(execution.step.toolName && this.shouldReviewTool(execution.step.toolName));
  }

  public shouldReviewExecutions(executions: readonly ToolExecutionRecord[]): boolean {
    return executions.some((execution) => this.shouldReviewExecution(execution));
  }
}

export const defaultReviewPolicy = new ReviewPolicy();
