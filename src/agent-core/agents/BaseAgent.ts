import type { ModelClient } from "../model/ModelClient.js";
import { parseAgentJson } from "../validation/parseAgentJson.js";
import type { AgentContext } from "../runtime/AgentContext.js";
import { AgentError } from "../runtime/AgentError.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import {
  AgentDecisionSchema,
  type AgentDecision,
  type AgentName,
} from "../validation/AgentOutputSchemas.js";

export type AgentInput = {
  context: AgentContext;
  task?: string;
  routeHint?: AgentName;
};

export interface Agent {
  name: AgentName;
  allowedTools: string[];
  decide(input: AgentInput): Promise<AgentDecision>;
}

export abstract class BaseAgent implements Agent {
  public abstract readonly name: AgentName;
  public abstract readonly allowedTools: string[];

  protected constructor(
    private readonly deps: {
      modelClient?: ModelClient;
      promptRegistry: PromptRegistry;
    },
  ) {}

  public async decide(input: AgentInput): Promise<AgentDecision> {
    if (!this.deps.modelClient) {
      throw new AgentError("MODEL_FAILED", "Agent model client is not configured.");
    }
    try {
      const response = await this.deps.modelClient.chat({
        responseFormat: "json",
        temperature: 0.1,
        maxTokens: 800,
        metadata: { agentName: `agent-core:${this.name}` },
        messages: [
          { role: "system", content: this.deps.promptRegistry.get(this.name) },
          { role: "user", content: JSON.stringify(this.buildPayload(input)) },
        ],
      });
      const parsed = parseAgentJson(response.content);
      const result = AgentDecisionSchema.safeParse(parsed);
      if (!result.success) {
        throw new AgentError("INVALID_AGENT_OUTPUT", "Agent returned invalid output.", {
          statusCode: 502,
          details: { agentName: this.name },
        });
      }
      return result.data;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("MODEL_FAILED", "Agent model call failed.", { cause: error });
    }
  }

  protected buildPayload(input: AgentInput): Record<string, unknown> {
    return {
      agentName: this.name,
      userMessage: input.context.userMessage,
      task: input.task,
      routeHint: input.routeHint,
      recentMessages: input.context.recentMessages.map((message) => ({
        role: message.role,
        kind: message.kind,
        content: message.content,
      })),
      clientState: input.context.clientState ?? {},
      activeAssetContext: input.context.activeAssetContext ?? {},
      productContext: input.context.productContext,
      availableTools: input.context.availableTools
        .filter((tool) => this.allowedTools.includes(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          mutability: tool.mutability,
          requiresConfirmation: tool.requiresConfirmation,
          riskLevel: tool.riskLevel,
        })),
      outputContract: {
        agentName: this.name,
        responseType: "route | plan | final | ask_clarification | error",
        routeTo: "frontdesk | experience_receiver | strategist | architect | critic",
        plan: [{ id: "step id", agentName: this.name, toolName: "allowed tool", arguments: {}, summary: "display summary" }],
      },
    };
  }
}
