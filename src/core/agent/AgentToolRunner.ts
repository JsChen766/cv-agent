import type { LLMMessage } from "../model/types.js";
import type { ToolExecutor } from "../tool/ToolExecutor.js";
import type {
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from "../tool/types.js";
import type { BaseAgent } from "./BaseAgent.js";
import type { AgentInput, AgentOutput } from "./types.js";

const DEFAULT_MAX_TOOL_ROUNDS = 3;
const CONTINUE_WITH_TOOL_RESULTS_PROMPT = "Continue using the tool results above and provide the final answer.";

export type AgentToolRunnerConfig = {
  agent: BaseAgent;
  toolExecutor: ToolExecutor;
  maxToolRounds?: number;
  toolExecutionContext?: ToolExecutionContext;
};

export type AgentToolRunnerRunInput = AgentInput & {
  toolChoice?: "auto" | "none" | "required" | string;
};

export type AgentToolRunStep = {
  round: number;
  agentOutput: AgentOutput;
  toolCalls: ToolCall[];
  toolResults: ToolExecutionResult[];
};

export type AgentToolRunnerOutput = AgentOutput & {
  steps: AgentToolRunStep[];
  finalMessages: LLMMessage[];
};

export class AgentToolRunner {
  private readonly agent: BaseAgent;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxToolRounds: number;
  private readonly toolExecutionContext?: ToolExecutionContext;

  public constructor(config: AgentToolRunnerConfig) {
    this.agent = config.agent;
    this.toolExecutor = config.toolExecutor;
    this.maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.toolExecutionContext = config.toolExecutionContext;
  }

  public async run(input: AgentToolRunnerRunInput): Promise<AgentToolRunnerOutput> {
    const steps: AgentToolRunStep[] = [];
    const finalMessages: LLMMessage[] = [
      ...(input.messages ?? []),
      { role: "user", content: input.content }
    ];

    let output = await this.agent.run(input);

    while (true) {
      const toolCalls = this.normalizeToolCalls(output.toolCalls ?? [], steps.length + 1);

      if (toolCalls.length === 0) {
        finalMessages.push(this.toAssistantMessage(output));
        return this.toRunnerOutput(output, steps, finalMessages);
      }

      if (steps.length >= this.maxToolRounds) {
        finalMessages.push(this.toAssistantMessage(output, toolCalls));
        return this.toRunnerOutput(output, steps, finalMessages, {
          toolLoopStopped: "max_tool_rounds"
        });
      }

      finalMessages.push(this.toAssistantMessage(output, toolCalls));

      const toolResults = await Promise.all(
        toolCalls.map((toolCall) => this.toolExecutor.executeToolCall(toolCall, this.toolExecutionContext))
      );

      finalMessages.push(
        ...toolCalls.map((toolCall, index) => this.toToolMessage(toolCall, toolResults[index]))
      );

      steps.push({
        round: steps.length + 1,
        agentOutput: output,
        toolCalls,
        toolResults
      });

      output = await this.agent.run({
        ...input,
        messages: finalMessages,
        content: CONTINUE_WITH_TOOL_RESULTS_PROMPT,
        toolChoice: "auto"
      });
    }
  }

  private normalizeToolCalls(toolCalls: ToolCall[], round: number): ToolCall[] {
    return toolCalls.map((toolCall, index) => ({
      ...toolCall,
      id: toolCall.id ?? `tool-call-${round}-${index + 1}`
    }));
  }

  private toAssistantMessage(output: AgentOutput, toolCalls?: ToolCall[]): LLMMessage {
    return {
      role: "assistant",
      content: output.content ?? "",
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(output.reasoning ? { reasoningContent: output.reasoning } : {}),
      ...(output.raw ? { raw: output.raw } : {})
    };
  }

  private toToolMessage(toolCall: ToolCall, toolResult: ToolExecutionResult): LLMMessage {
    return {
      role: "tool",
      toolCallId: toolCall.id,
      content: JSON.stringify(toolResult)
    };
  }

  private toRunnerOutput(
    output: AgentOutput,
    steps: AgentToolRunStep[],
    finalMessages: LLMMessage[],
    metadata?: Record<string, unknown>
  ): AgentToolRunnerOutput {
    const toolErrors = steps
      .flatMap((step) => step.toolResults)
      .filter((toolResult) => !toolResult.ok);

    return {
      ...output,
      metadata: {
        ...output.metadata,
        ...(toolErrors.length ? { toolErrors } : {}),
        ...metadata
      },
      steps,
      finalMessages
    };
  }
}
