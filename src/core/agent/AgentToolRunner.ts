import type { LLMMessage } from "../model/types.js";
import { ContextAssembler } from "../conversation/ContextAssembler.js";
import { ConversationSession } from "../conversation/ConversationSession.js";
import type { ContextProvider } from "../conversation/ContextProvider.js";
import type { TokenBudgetTrimOptions } from "../conversation/TokenBudgetManager.js";
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
  conversationSession?: ConversationSession;
  contextAssembler?: ContextAssembler;
  trimOptions?: TokenBudgetTrimOptions;
  contextProviders?: ContextProvider[];
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
  conversationSession: ConversationSession;
};

export class AgentToolRunner {
  private readonly agent: BaseAgent;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxToolRounds: number;
  private readonly toolExecutionContext?: ToolExecutionContext;
  private readonly conversationSession: ConversationSession;
  private readonly contextAssembler?: ContextAssembler;
  private readonly trimOptions?: TokenBudgetTrimOptions;
  private readonly contextProviders: ContextProvider[];

  public constructor(config: AgentToolRunnerConfig) {
    this.agent = config.agent;
    this.toolExecutor = config.toolExecutor;
    this.maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.toolExecutionContext = config.toolExecutionContext;
    this.conversationSession = config.conversationSession ?? new ConversationSession();
    this.contextAssembler = config.contextAssembler;
    this.trimOptions = config.trimOptions;
    this.contextProviders = config.contextProviders ?? [];
  }

  public async run(input: AgentToolRunnerRunInput): Promise<AgentToolRunnerOutput> {
    const steps: AgentToolRunStep[] = [];
    this.conversationSession.appendMany(input.messages ?? []);
    this.conversationSession.append({ role: "user", content: input.content });

    let output = await this.agent.run({
      ...input,
      messages: await this.assembleMessages(input),
      skipAppendingUserContent: true
    });

    while (true) {
      const toolCalls = this.normalizeToolCalls(output.toolCalls ?? [], steps.length + 1);

      if (toolCalls.length === 0) {
        this.conversationSession.append(this.toAssistantMessage(output));
        return this.toRunnerOutput(output, steps);
      }

      if (steps.length >= this.maxToolRounds) {
        this.conversationSession.append(this.toAssistantMessage(output, toolCalls));
        return this.toRunnerOutput(output, steps, {
          toolLoopStopped: "max_tool_rounds"
        });
      }

      this.conversationSession.append(this.toAssistantMessage(output, toolCalls));

      const toolResults = await Promise.all(
        toolCalls.map((toolCall) => this.toolExecutor.executeToolCall(toolCall, this.toolExecutionContext))
      );

      this.conversationSession.appendMany(
        toolCalls.map((toolCall, index) => this.toToolMessage(toolCall, toolResults[index]))
      );

      steps.push({
        round: steps.length + 1,
        agentOutput: output,
        toolCalls,
        toolResults
      });

      output = await this.agent.run({
        ...input,
        messages: await this.assembleMessages(input),
        content: CONTINUE_WITH_TOOL_RESULTS_PROMPT,
        toolChoice: "auto"
      });
    }
  }

  private async assembleMessages(input: AgentToolRunnerRunInput): Promise<LLMMessage[]> {
    const injections = (await Promise.all(
      this.contextProviders.map((provider) => provider.getContext({
        sessionId: this.conversationSession.id,
        task: input.content,
        metadata: input.metadata
      }))
    )).flat();

    if (this.contextAssembler || injections.length || this.trimOptions) {
      return (this.contextAssembler ?? new ContextAssembler()).assemble({
        session: this.conversationSession,
        injections,
        trimOptions: this.trimOptions
      }).messages;
    }

    return this.conversationSession.getLLMMessages();
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
      finalMessages: this.conversationSession.getLLMMessages(),
      conversationSession: this.conversationSession
    };
  }
}
