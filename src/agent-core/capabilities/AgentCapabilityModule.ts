import type { ContextProvider } from "../memory/ContextProvider.js";

export type { ContextProvider };

export type RetrievalProvider = {
  readonly id: string;
};

export type MemoryProvider = {
  readonly id: string;
};

export type ReflectionSink = {
  readonly id: string;
};

export type EvaluationHook = {
  readonly id: string;
};

export type AgentCapabilityModule = {
  readonly id: string;
  readonly contextProviders?: readonly ContextProvider[];
  readonly retrievalProviders?: readonly RetrievalProvider[];
  readonly memoryProviders?: readonly MemoryProvider[];
  readonly reflectionSinks?: readonly ReflectionSink[];
  readonly evaluationHooks?: readonly EvaluationHook[];
};
