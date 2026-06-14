import type { ContextProvider } from "../context/ContextProvider.js";
import type { EvaluationHook } from "../evaluation/EvaluationHook.js";
import type { MemoryProvider } from "../memory/MemoryProvider.js";
import type { ReflectionSink } from "../reflection/ReflectionSink.js";
import type { RetrievalProvider } from "../retrieval/RetrievalProvider.js";

export type { ContextProvider };
export type { EvaluationHook };
export type { MemoryProvider };
export type { ReflectionSink };
export type { RetrievalProvider };

export type AgentCapabilityModule = {
  readonly id: string;
  readonly contextProviders?: readonly ContextProvider[];
  readonly retrievalProviders?: readonly RetrievalProvider[];
  readonly memoryProviders?: readonly MemoryProvider[];
  readonly reflectionSinks?: readonly ReflectionSink[];
  readonly evaluationHooks?: readonly EvaluationHook[];
};
