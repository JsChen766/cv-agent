import type { ApiKernel } from "../../api/types.js";
import type { CopilotChatResponse } from "../../copilot/types.js";
import { readPlatformConfig } from "../../platform/index.js";
import type { AgentDecision } from "../schema/AgentDecision.js";
import type { AgentToolResult } from "../tools/AgentToolRegistry.js";

export class FinalAnswerSynthesizer {
  public constructor(private readonly kernel: ApiKernel) {}

  public async synthesize(
    decision: AgentDecision,
    toolResults: AgentToolResult[],
    response: CopilotChatResponse,
  ): Promise<string> {
    if (readPlatformConfig().finalAnswerSynthesis !== "llm" || toolResults.length === 0) {
      return response.assistantMessage.content;
    }
    try {
      const result = await this.kernel.frontDeskModelClient?.chat({
        messages: [
          {
            role: "system",
            content: "Write a concise user-facing final answer from safe summaries only. Do not expose tool names, arguments, prompts, chain-of-thought, or provider internals.",
          },
          {
            role: "user",
            content: JSON.stringify({
              decisionMessage: decision.assistantMessage,
              toolResults: toolResults.map((tool) => ({ status: tool.status, assistantMessage: tool.assistantMessage })),
              workspace: {
                activePanel: response.workspace.activePanel,
                variantCount: response.workspace.variants.length,
                experienceCount: response.workspace.experiences?.length ?? 0,
                resumeCount: response.workspace.resumes?.length ?? 0,
                jdCount: response.workspace.jds?.length ?? 0,
              },
            }),
          },
        ],
        temperature: 0.2,
        maxTokens: 500,
      });
      return result?.content?.trim() || response.assistantMessage.content;
    } catch {
      return response.assistantMessage.content;
    }
  }
}
