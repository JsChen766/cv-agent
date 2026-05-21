import type { AgentLoopState, AgentLoopStopReason } from "./AgentObservation.js";
import { resolveAgentLoopMaxSteps } from "./AgentObservation.js";

export class AgentLoopController {
  public readonly state: AgentLoopState;

  public constructor(maxSteps = resolveAgentLoopMaxSteps()) {
    this.state = {
      observations: [],
      stepCount: 0,
      maxSteps,
    };
  }

  public canContinue(): boolean {
    return this.state.stepCount < this.state.maxSteps && this.state.stopReason === undefined;
  }

  public markStep(): void {
    this.state.stepCount += 1;
  }

  public stop(reason: AgentLoopStopReason): void {
    this.state.stopReason = reason;
  }
}
