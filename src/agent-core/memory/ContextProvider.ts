import type { AgentContext } from "../runtime/AgentContext.js";

export interface ContextProvider {
  provide(context: AgentContext): Promise<Record<string, unknown>>;
}
