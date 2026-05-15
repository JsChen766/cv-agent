import { toToolSchema } from "../tool/ToolDefinition.js";
import type { ModelClient } from "../model/ModelClient.js";
import type { ToolDefinition } from "../tool/types.js";
import type { AgentInput, AgentOutput, BaseAgentConfig } from "./types.js";

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
      { role: "system" as const, content: this.systemPrompt },
      ...(input.messages ?? []),
      ...(input.skipAppendingUserContent ? [] : [{ role: "user" as const, content: input.content }])
    ];

    const response = await this.modelClient.chat({
      model: input.model,
      messages,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      tools: this.tools?.map(toToolSchema),
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat ?? this.defaultResponseFormat,
      thinking: input.thinking,
      metadata: {
        agentName: this.name,
        agentRole: this.role,
        ...input.metadata
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
