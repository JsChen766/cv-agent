import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import type { Agent } from "../agents/BaseAgent.js";
import type { AgentName } from "../validation/AgentOutputSchemas.js";
import type { ToolDefinition } from "../tools/Tool.js";

export type AgentFactoryDeps = {
  modelClient?: ModelClient;
  promptRegistry: PromptRegistry;
};

export type AgentFactory = {
  name: AgentName;
  create: (deps: AgentFactoryDeps) => Agent;
};

/**
 * A static, type-safe module that bundles agents and tools for a domain.
 * New domains (e.g. study-abroad) add a new module without modifying
 * AgentOrchestrator or createAgentTools internals.
 */
export type AgentDomainModule = {
  /** Unique domain identifier, e.g. "career", "study-abroad" */
  id: string;
  /** Agent factories — must have unique AgentName */
  agents?: readonly AgentFactory[];
  /** Tool definitions — must have unique name */
  tools?: readonly ToolDefinition[];
};
