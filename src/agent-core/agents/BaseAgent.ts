import type { ModelClient } from "../model/ModelClient.js";
import { parseAgentJson } from "../validation/parseAgentJson.js";
import type { AgentContext } from "../runtime/AgentContext.js";
import { AgentError } from "../runtime/AgentError.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import {
  AgentDecisionSchema,
  repairAgentDecision,
  type AgentDecision,
  type AgentName,
} from "../validation/AgentOutputSchemas.js";
import { fallbackAgentDecision } from "./deterministicAgentFallback.js";

const DEBUG = process.env.ENABLE_AGENT_DECISION_DEBUG === "true";

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

export type AgentDecisionMeta = {
  decisionSource: "llm" | "repaired" | "fallback";
  fallbackReason?: string;
  modelUsed: boolean;
  schemaValid: boolean;
  repairApplied: boolean;
  rawOutput?: unknown;
};

const decisionMeta = new WeakMap<object, AgentDecisionMeta>();

export function getAgentDecisionMeta(decision: unknown): AgentDecisionMeta | undefined {
  return typeof decision === "object" && decision !== null ? decisionMeta.get(decision) : undefined;
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
    // If no modelClient, use deterministic fallback directly
    if (!this.deps.modelClient) {
      return this.applyFallback(input, "modelClient not configured");
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

      if (DEBUG) {
        console.debug("[AgentDecision]", {
          agentName: this.name,
          rawPreview: response.content.slice(0, 300),
        });
      }

      // Try to parse JSON
      let parsed: unknown;
      try {
        parsed = parseAgentJson(response.content);
      } catch {
        // Try extract JSON from text as a last resort
        const extracted = this.extractJsonFromText(response.content);
        if (extracted !== null) {
          parsed = extracted;
        } else {
          if (DEBUG) console.debug("[AgentDecision] JSON parse failed, using fallback");
          return this.applyFallback(input, "JSON parse failed");
        }
      }

      // Try schema validation
      const result = AgentDecisionSchema.safeParse(parsed);
      if (result.success) {
        // Quality check: defaults may have filled in empty values
        // Always attempt repair to ensure minimum quality
        const repaired = repairAgentDecision(parsed, this.name);
        if (repaired) {
          if (DEBUG) console.debug("[AgentDecision] parsed+repaired success");
          return rememberDecisionMeta(repaired, {
            decisionSource: sameJson(result.data, repaired) ? "llm" : "repaired",
            modelUsed: true,
            schemaValid: true,
            repairApplied: !sameJson(result.data, repaired),
            rawOutput: parsed,
          });
        }
        if (DEBUG) console.debug("[AgentDecision] parsed success");
        return rememberDecisionMeta(result.data, {
          decisionSource: "llm",
          modelUsed: true,
          schemaValid: true,
          repairApplied: false,
          rawOutput: parsed,
        });
      }

      // Try repair
      const repaired = repairAgentDecision(parsed, this.name);
      if (repaired) {
        if (DEBUG) console.debug("[AgentDecision] repaired success");
        return rememberDecisionMeta(repaired, {
          decisionSource: "repaired",
          modelUsed: true,
          schemaValid: false,
          repairApplied: true,
          rawOutput: parsed,
        });
      }

      if (DEBUG) console.debug("[AgentDecision] schema validation failed, using fallback");
      return this.applyFallback(input, "schema validation failed");
    } catch (error) {
      if (error instanceof AgentError) {
        // Only throw if it's a fatal error (provider truly unavailable)
        // For MODEL_FAILED, still try fallback
        if (error.code === "MODEL_FAILED") {
          return this.applyFallback(input, `model failed: ${error.message}`);
        }
        throw error;
      }
      return this.applyFallback(input, `unexpected error: ${String(error)}`);
    }
  }

  private applyFallback(input: AgentInput, reason: string): AgentDecision {
    if (DEBUG) {
      console.debug("[AgentDecision]", {
        agentName: this.name,
        fallbackReason: reason,
        fallbackUsed: true,
      });
    }
    const fallback = fallbackAgentDecision(this.name, {
      userMessage: input.context.userMessage,
      clientState: input.context.clientState ?? {},
    });
    return rememberDecisionMeta(fallback, {
      decisionSource: "fallback",
      fallbackReason: reason,
      modelUsed: false,
      schemaValid: false,
      repairApplied: false,
    });
  }

  private extractJsonFromText(text: string): unknown | null {
    // Try to find a JSON object in the text
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
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
      observations: (input.context.observations ?? []).slice(-8).map((observation) => ({
        id: observation.id,
        stepId: observation.stepId,
        agentName: observation.agentName,
        toolName: observation.toolName,
        status: observation.status,
        message: observation.message,
        data: summarizeForAgent(observation.data, 1200),
        createdAt: observation.createdAt,
      })),
      agentMessages: (input.context.agentMessages ?? [])
        .filter((message) =>
          message.to === this.name ||
          message.from === this.name ||
          (message.from === "orchestrator" && message.to === this.name)
        )
        .slice(-12)
        .map((message) => ({
          id: message.id,
          from: message.from,
          to: message.to,
          type: message.type,
          content: message.content,
          payload: summarizeForAgent(message.payload, 1200),
          createdAt: message.createdAt,
        })),
      loopState: input.context.loopState
        ? {
            stepCount: input.context.loopState.stepCount,
            maxSteps: input.context.loopState.maxSteps,
            stopReason: input.context.loopState.stopReason,
            observationCount: input.context.loopState.observations.length,
          }
        : undefined,
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
        criticReview: this.name === "critic"
          ? {
              verdict: "pass | needs_revision | blocked | needs_user_confirmation",
              riskLevel: "low | medium | high",
              unsupportedClaims: [],
              missingEvidence: [],
              suggestedFixes: [],
              userVisibleSummary: "short user-facing summary",
            }
          : undefined,
      },
    };
  }
}

function rememberDecisionMeta<T extends AgentDecision>(decision: T, meta: AgentDecisionMeta): T {
  decisionMeta.set(decision, meta);
  return decision;
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function summarizeForAgent(value: unknown, maxLength: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxLength) return value;
    return `${text.slice(0, maxLength)}...`;
  } catch {
    return "[unserializable]";
  }
}
