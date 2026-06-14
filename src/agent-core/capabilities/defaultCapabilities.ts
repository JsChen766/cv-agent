import type { AgentCapabilityModule } from "./AgentCapabilityModule.js";

const noopCapabilityModule: AgentCapabilityModule = {
  id: "core.noop",
};

export function createDefaultCapabilities(): AgentCapabilityModule[] {
  return [noopCapabilityModule];
}
