import type { AgentRegistry } from "../agent/AgentRegistry.js";
import type { AgentInput, AgentOutput } from "../agent/types.js";
import type { WorkflowRunResult, WorkflowTraceStep } from "./types.js";

export class Orchestrator {
  private readonly registry: AgentRegistry;

  public constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  public async runPipeline(agentNames: string[], input: AgentInput): Promise<WorkflowRunResult<AgentOutput>> {
    const trace: WorkflowTraceStep[] = [];
    let currentInput = input;
    let finalOutput: AgentOutput | undefined;

    for (const agentName of agentNames) {
      const startedAt = new Date().toISOString();
      const stepName = `agent:${agentName}`;

      try {
        const agent = this.registry.get(agentName);
        const output = await agent.run(currentInput);
        const endedAt = new Date().toISOString();

        trace.push({
          stepName,
          agentName,
          input: currentInput,
          output,
          startedAt,
          endedAt,
          status: "success"
        });

        finalOutput = output;
        currentInput = {
          ...currentInput,
          content: output.content,
          metadata: {
            ...currentInput.metadata,
            previousAgent: agentName
          }
        };
      } catch (error) {
        trace.push({
          stepName,
          agentName,
          input: currentInput,
          startedAt,
          endedAt: new Date().toISOString(),
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }
    }

    return { output: finalOutput, trace };
  }
}
