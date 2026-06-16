import type { PendingAction } from "../../agent-core/confirmation/PendingAction.js";
import type { ModelClient } from "../../agent-core/model/ModelClient.js";
import type { ToolResult } from "../../agent-core/tools/ToolResult.js";
import type { CriticReview } from "../../agent-core/validation/AgentOutputSchemas.js";
import type { CopilotLocale } from "../locale.js";
import type { CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";

export type NarratorBranch = "generated" | "accepted" | "exported" | "jd_match";

export type NarratorInput = {
  locale: CopilotLocale;
  userMessage: string;
  toolResults: ToolResult[];
  branch: NarratorBranch;
  workspace?: CopilotWorkspace | null;
  pendingActions?: PendingAction[];
  criticReview?: CriticReview;
  frontDeskHandoff?: FrontDeskHandoff;
  fallbackText?: string;
};

export type NarratorOptions = {
  modelClient?: ModelClient;
  prompt: string;
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
};

export class NarratorService {
  private readonly modelClient: ModelClient | undefined;
  private readonly prompt: string;
  private readonly enabled: boolean;
  private readonly temperature: number;
  private readonly maxTokens: number;

  public constructor(options: NarratorOptions) {
    this.modelClient = options.modelClient;
    this.prompt = options.prompt;
    this.enabled = options.enabled ?? (process.env.ENABLE_NARRATOR === "true");
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 600;
  }

  public async narrate(input: NarratorInput): Promise<string | null> {
    if (!this.enabled) return null;
    if (!this.modelClient) return null;

    const userPayload = this.buildUserPayload(input);
    try {
      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: this.prompt },
          { role: "user", content: userPayload },
        ],
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      });
      const text = (response.content ?? "").trim();
      if (!text) return null;
      return text;
    } catch {
      return null;
    }
  }

  private buildUserPayload(input: NarratorInput): string {
    const compactResults = input.toolResults.map((result) => ({
      status: result.status,
      resultKind: (result as { resultKind?: string }).resultKind,
      message: result.message,
      summaryFacts: (result as { summaryFacts?: string[] }).summaryFacts,
      entities: (result as { entities?: unknown }).entities,
      evidence: (result as { evidence?: unknown }).evidence,
      warnings: (result as { warnings?: string[] }).warnings,
      nextActionHints: (result as { nextActionHints?: unknown }).nextActionHints,
      actionType: result.actionResult?.actionType,
      actionStatus: result.actionResult?.status,
    }));
    const payload = {
      locale: input.locale,
      branch: input.branch,
      userMessage: input.userMessage,
      fallbackText: input.fallbackText,
      criticReview: input.criticReview ? {
        verdict: input.criticReview.verdict,
        userVisibleSummary: input.criticReview.userVisibleSummary,
      } : undefined,
      frontDeskIntent: input.frontDeskHandoff?.intent,
      toolResults: compactResults,
    };
    return JSON.stringify(payload);
  }
}
