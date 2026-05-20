import type { AgentContext } from "../runtime/AgentContext.js";
import type { ContextProvider } from "./ContextProvider.js";

export class ProductContextProvider implements ContextProvider {
  public async provide(context: AgentContext): Promise<Record<string, unknown>> {
    return {
      workspace: context.workspace ? {
        status: context.workspace.status,
        activePanel: context.workspace.activePanel,
        resumeId: context.workspace.resumeId,
        jdId: context.workspace.jdId,
        activeVariantId: context.workspace.activeVariantId,
      } : null,
      clientState: context.clientState ?? {},
      activeAssetContext: context.activeAssetContext ?? {},
    };
  }
}
