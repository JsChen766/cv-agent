import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";

/**
 * Test-only smart stub provider for narrator e2e tests.
 *
 * Purpose: a single `frontDeskModelClient` must serve both
 *   (1) agent-decision flow (frontdesk/strategist/architect/critic), which
 *       uses `responseFormat: "json"` and `metadata.agentName`, AND
 *   (2) the Narrator presenter, which uses `responseFormat` undefined and a
 *       system prompt starting with "You are the Narrator".
 *
 * Branching rules:
 * - When `request.responseFormat !== "json"` AND the system prompt contains
 *   "Narrator", we treat the call as a narrator invocation and return
 *   `narratorReply`. This is the wire-through path the e2e test asserts.
 * - Otherwise we delegate to `decide()`, which mirrors the JSON decision
 *   shape used by `tests/copilotKernelRefactor.test.ts`'s
 *   `KernelRefactorProvider`. This keeps the agent-decision flow working
 *   so a JD intake → "那就生成吧" → confirm pending → generate flow
 *   actually produces a `pendingActionId` and runs `generate_resume_from_jd`.
 *
 * Important: this helper lives in `tests/` and MUST NOT be imported by any
 * production code. It is also forbidden to extend the production
 * `KernelRefactorProvider` (or any production provider) with narrator
 * special-cases.
 */

export type ScenarioProviderOptions = {
  narratorReply?: string;
  name?: string;
};

const DEFAULT_NAME = "scenario-narrator-stub";

export function makeScenarioProvider(options: ScenarioProviderOptions = {}): LLMProvider {
  const narratorReply = options.narratorReply ?? "narrator: deterministic stub reply";
  const name = options.name ?? DEFAULT_NAME;
  return {
    name,
    chat: async (request: LLMChatRequest): Promise<LLMChatResponse> => {
      if (isNarratorRequest(request)) {
        return { content: narratorReply };
      }
      return decideAgentJson(request);
    },
  };
}

function isNarratorRequest(request: LLMChatRequest): boolean {
  if (request.responseFormat === "json") return false;
  const systemMessage = request.messages.find((message) => message.role === "system");
  if (!systemMessage) return false;
  return systemMessage.content.includes("Narrator");
}

function decideAgentJson(request: LLMChatRequest): LLMChatResponse {
  const agentName = request.metadata?.agentName;
  const payload = readPayload(request);
  const message = String(payload.userMessage ?? "");

  if (agentName === "agent-core:frontdesk") {
    if (message === "那就生成吧") {
      return json({
        agentName: "frontdesk",
        responseType: "route",
        routeTo: "architect",
        assistantMessage: "",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
        handoff: { intent: "resume.generate_from_jd", routeTo: "architect", extracted: {}, suggestedActions: ["generate_resume"], next: "execute_task" },
      });
    }
    return json({
      agentName: "frontdesk",
      responseType: "route",
      routeTo: "strategist",
      assistantMessage: "",
      plan: [],
      missingInputs: [],
      confidence: 0.9,
      handoff: { intent: "jd.intake", routeTo: "strategist", extracted: { jdText: message, targetRole: "Senior Frontend Engineer" }, suggestedActions: ["save_jd", "analyze_jd", "generate_resume"], next: "handoff" },
    });
  }
  if (agentName === "agent-core:architect") {
    return json(planMessage("architect", "generate_resume_from_jd", {}, "Generate resume from JD."));
  }
  if (agentName === "agent-core:strategist") {
    return json(planMessage("strategist", "analyze_jd", { text: message }, "Analyze JD."));
  }
  if (agentName === "agent-core:critic") {
    return json({
      agentName: "critic",
      responseType: "final",
      assistantMessage: "pass",
      plan: [],
      missingInputs: [],
      confidence: 0.9,
      criticReview: {
        verdict: "pass",
        riskLevel: "low",
        unsupportedClaims: [],
        missingEvidence: [],
        suggestedFixes: [],
        userVisibleSummary: "pass",
      },
    });
  }
  return json(planMessage("strategist", "analyze_jd", { text: message }, "Analyze JD."));
}

function readPayload(request: LLMChatRequest): Record<string, unknown> {
  const text = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "{}";
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function planMessage(agentName: string, toolName: string, args: Record<string, unknown>, summary: string): Record<string, unknown> {
  return {
    agentName,
    responseType: "plan",
    assistantMessage: "",
    plan: [{ id: "step-1", agentName, toolName, arguments: args, summary }],
    missingInputs: [],
    confidence: 0.9,
  };
}

function json(value: Record<string, unknown>): LLMChatResponse {
  return { content: JSON.stringify(value) };
}
