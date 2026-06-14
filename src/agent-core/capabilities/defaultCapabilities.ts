import type { AgentCapabilityModule } from "./AgentCapabilityModule.js";
import { NoopRetrievalProvider } from "../retrieval/NoopRetrievalProvider.js";

const noopCapabilityModule: AgentCapabilityModule = {
  id: "core.noop",
  retrievalProviders: [new NoopRetrievalProvider()],
};

export function createDefaultCapabilities(): AgentCapabilityModule[] {
  return [noopCapabilityModule];
}
