import { getAgentDecisionMeta, type Agent, type AgentDecisionMeta, type AgentInput } from "../agents/BaseAgent.js";
import type { AgentDecision } from "../validation/AgentOutputSchemas.js";
import type { AgentTraceRecorder, AgentTraceStep, AgentTraceStepStatus } from "./AgentTrace.js";

export type AgentDecisionRunnerInput = AgentInput & {
  agent: Agent;
};

export class AgentDecisionRunner {
  public async decide(input: AgentDecisionRunnerInput): Promise<AgentDecision> {
    return input.agent.decide({
      context: input.context,
      routeHint: input.routeHint,
      task: input.task,
    });
  }

  public decisionMeta(decision: unknown): AgentDecisionMeta | undefined {
    return getAgentDecisionMeta(decision);
  }

  public decisionTraceMeta(decision: unknown): Record<string, unknown> | undefined {
    const meta = this.decisionMeta(decision);
    if (!meta) return undefined;
    return {
      decisionSource: meta.decisionSource,
      fallbackReason: meta.fallbackReason,
      modelUsed: meta.modelUsed,
      schemaValid: meta.schemaValid,
      repairApplied: meta.repairApplied,
    };
  }

  public completeDecisionTrace(input: {
    trace: AgentTraceRecorder;
    step: AgentTraceStep;
    decision: unknown;
    status?: AgentTraceStepStatus;
    metadata?: Record<string, unknown>;
  }): void {
    input.trace.complete(input.step, input.status ?? "success", {
      ...(input.metadata ?? {}),
      decision: this.decisionTraceMeta(input.decision),
    });
  }
}
