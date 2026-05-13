import type { AgentInput, AgentOutput } from "../agent/types.js";

export type WorkflowStepStatus = "success" | "failed";

export type WorkflowTraceStep = {
  stepName: string;
  agentName?: string;
  input: unknown;
  output?: unknown;
  startedAt: string;
  endedAt: string;
  status: WorkflowStepStatus;
  error?: string;
};

export type WorkflowRunResult<TOutput = unknown> = {
  output?: TOutput;
  trace: WorkflowTraceStep[];
};

export type AgentWorkflowStep = {
  type: "agent";
  name: string;
  agentName: string;
};

export type FunctionWorkflowStep<TState = unknown> = {
  type: "function";
  name: string;
  run: (state: TState) => Promise<TState>;
};

export type ConditionWorkflowStep = {
  type: "condition";
  name: string;
  description?: string;
};

export type WorkflowStep<TState = unknown> = AgentWorkflowStep | FunctionWorkflowStep<TState> | ConditionWorkflowStep;

export type WorkflowConfig<TInput = unknown, TState = unknown> = {
  id: string;
  name: string;
  steps: WorkflowStep<TState>[];
  initialState?: TState;
  run?: (input: TInput) => Promise<WorkflowRunResult<TState>>;
};

export type PipelineInput = AgentInput;
export type PipelineOutput = AgentOutput;
