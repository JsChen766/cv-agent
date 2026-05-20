import type { AgentContext } from "../runtime/AgentContext.js";
import type { ContextProvider } from "./ContextProvider.js";

export class ConversationContextProvider implements ContextProvider {
  public async provide(context: AgentContext): Promise<Record<string, unknown>> {
    return {
      recentMessages: context.recentMessages.map((message) => ({
        role: message.role,
        kind: message.kind,
        content: message.content,
      })),
    };
  }
}
