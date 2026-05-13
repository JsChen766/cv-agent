import type { WorkflowConfig, WorkflowRunResult, WorkflowStep } from "./types.js";

export class Workflow<TInput = unknown, TState = unknown> {
  public readonly id: string;
  public readonly name: string;
  public readonly steps: WorkflowStep<TState>[];
  public readonly initialState?: TState;
  private readonly runner?: (input: TInput) => Promise<WorkflowRunResult<TState>>;

  public constructor(config: WorkflowConfig<TInput, TState>) {
    this.id = config.id;
    this.name = config.name;
    this.steps = config.steps;
    this.initialState = config.initialState;
    this.runner = config.run;
  }

  public async run(input: TInput): Promise<WorkflowRunResult<TState>> {
    if (!this.runner) {
      return {
        output: this.initialState,
        trace: []
      };
    }
    return this.runner(input);
  }
}
