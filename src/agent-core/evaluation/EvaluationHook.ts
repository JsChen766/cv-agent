export type EvaluationRunInput = {
  userId?: string;
  sessionId?: string;
  turnId?: string;
  metadata?: Record<string, unknown>;
};

export type EvaluationRunOutput = {
  userId?: string;
  sessionId?: string;
  turnId?: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

export type EvaluationToolResult = {
  toolName?: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

export type EvaluationCriticReview = {
  verdict?: string;
  riskLevel?: string;
  metadata?: Record<string, unknown>;
};

export interface EvaluationHook {
  readonly id: string;
  beforeRun?(input: EvaluationRunInput): Promise<void>;
  afterRun?(output: EvaluationRunOutput): Promise<void>;
  onToolResult?(result: EvaluationToolResult): Promise<void>;
  onCriticReview?(review: EvaluationCriticReview): Promise<void>;
}
