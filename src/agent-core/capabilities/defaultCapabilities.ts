import type { AgentCapabilityModule } from "./AgentCapabilityModule.js";
import { NoopEvaluationHook } from "../evaluation/NoopEvaluationHook.js";
import { NoopMemoryProvider } from "../memory/NoopMemoryProvider.js";
import { NoopReflectionSink } from "../reflection/NoopReflectionSink.js";
import { NoopRetrievalProvider } from "../retrieval/NoopRetrievalProvider.js";

const noopCapabilityModule: AgentCapabilityModule = {
  id: "core.noop",
  retrievalProviders: [new NoopRetrievalProvider()],
  memoryProviders: [new NoopMemoryProvider()],
  reflectionSinks: [new NoopReflectionSink()],
  evaluationHooks: [new NoopEvaluationHook()],
};

export function createDefaultCapabilities(): AgentCapabilityModule[] {
  return [noopCapabilityModule];
}
