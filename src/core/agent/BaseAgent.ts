import { toToolSchema } from "../tool/ToolDefinition.js";
import type { ModelClient } from "../model/ModelClient.js";
import type { LLMMessage } from "../model/types.js";
import type { ToolDefinition } from "../tool/types.js";
import type { AgentInput, AgentOutput, AgentRunOptions, BaseAgentConfig } from "./types.js";

export abstract class BaseAgent {
  public readonly name: string;
  public readonly role: string;
  public readonly systemPrompt: string;
  public readonly modelClient: ModelClient;
  public readonly tools?: ToolDefinition[];
  protected readonly defaultResponseFormat?: "text" | "json";

  protected constructor(config: BaseAgentConfig) {
    this.name = config.name;
    this.role = config.role;
    this.systemPrompt = config.systemPrompt;
    this.modelClient = config.modelClient;
    this.tools = config.tools;
    this.defaultResponseFormat = config.defaultResponseFormat;
  }

  public async run(input: AgentInput): Promise<AgentOutput> {
    const messages = [
      ...(input.messages ?? []),
      ...(input.skipAppendingUserContent ? [] : [{ role: "user" as const, content: input.content }])
    ];

    return this.runWithMessages(messages, {
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
      thinking: input.thinking,
      metadata: input.metadata
    });
  }

  public async runWithMessages(
    messages: LLMMessage[],
    options: AgentRunOptions = {}
  ): Promise<AgentOutput> {
    const requestMessages = [
      { role: "system" as const, content: this.systemPrompt },
      ...messages
    ];

    const response = await this.modelClient.chat({
      model: options.model,
      messages: requestMessages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      tools: this.tools?.map(toToolSchema),
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat ?? this.defaultResponseFormat,
      thinking: options.thinking,
      metadata: {
        agentName: this.name,
        agentRole: this.role,
        ...options.metadata
      }
    });

    return {
      content: response.content,
      reasoning: response.reasoning,
      toolCalls: response.toolCalls,
      raw: response.raw,
      metadata: {
        usage: response.usage,
        providerResponse: response.raw
      }
    };
  }
}
