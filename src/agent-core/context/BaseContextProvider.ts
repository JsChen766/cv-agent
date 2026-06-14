import type { ContextProvider } from "./ContextProvider.js";
import type { AgentContext } from "../runtime/AgentContext.js";

export class BaseContextProvider implements ContextProvider {
  public async provide(context: AgentContext): Promise<Record<string, unknown>> {
    return {
      userId: context.userId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      clientState: context.clientState ?? {},
      workspaceStatus: context.workspace?.status,
    };
  }
}
