import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import type { AgentContext } from "../src/agent-core/runtime/AgentContext.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import type { ToolDefinition } from "../src/agent-core/tools/Tool.js";
import { createTestKernelContext } from "../src/api/context.js";

export function setupP12Env(): void {
  process.env.AUTH_MODE = "dev_header";
  process.env.NODE_ENV = "test";
  delete process.env.DATABASE_URL;
}

export async function createP12Kernel(): Promise<ApiKernel> {
  setupP12Env();
  const kernel = await createKernel();
  kernel.frontDeskModelClient = new ModelClient({
    provider: new P12TestProvider(),
    defaultModel: "p12-test",
  });
  return kernel;
}

export function testContext(kernel: ApiKernel, tools: ToolDefinition[] = [], userId = "user-1"): AgentContext {
  const requestContext = createTestKernelContext({ user: { id: userId }, request: { requestId: "req-1", traceId: "trace-1" } });
  return {
    kernel,
    requestContext,
    userId,
    sessionId: "cs-test",
    turnId: "ct-test",
    userMessage: "",
    recentMessages: [],
    workspace: null,
    clientState: {},
    productContext: {},
    availableTools: tools,
    trace: new AgentTraceRecorder().trace,
  };
}

class P12TestProvider implements LLMProvider {
  public readonly name = "p12-test";

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const agentName = request.metadata?.agentName;
    const payload = readPayload(request);
    const message = String(payload.userMessage ?? "").toLowerCase();
    if (agentName === "agent-core:frontdesk") return json(this.frontdesk(message));
    if (agentName === "agent-core:experience_receiver") return json(this.experience(message));
    if (agentName === "agent-core:architect") return json(this.architect(message, payload));
    if (agentName === "agent-core:critic") return json(plan("critic", "show_evidence", { id: "current" }, "Show evidence."));
    if (agentName === "agent-core:strategist") return json(plan("strategist", "list_experiences", {}, "List experiences."));
    return json({ agentName: "frontdesk", responseType: "ask_clarification", assistantMessage: "Please clarify.", plan: [], missingInputs: ["intent"], confidence: 0.5 });
  }

  private frontdesk(message: string): Record<string, unknown> {
    if (message.includes("experience") || message.includes("library") || message.includes("save") || message.includes("delete")) {
      return { agentName: "frontdesk", responseType: "route", routeTo: "experience_receiver", assistantMessage: "", plan: [], missingInputs: [], confidence: 0.9 };
    }
    if (message.includes("resume") || message.includes("export") || message.includes("jd")) {
      return { agentName: "frontdesk", responseType: "route", routeTo: "architect", assistantMessage: "", plan: [], missingInputs: [], confidence: 0.9 };
    }
    return { agentName: "frontdesk", responseType: "ask_clarification", assistantMessage: "Please clarify.", plan: [], missingInputs: ["intent"], confidence: 0.5 };
  }

  private experience(message: string): Record<string, unknown> {
    if (message.includes("save")) return plan("experience_receiver", "save_experience_from_text", { text: message }, "Save experience after confirmation.");
    if (message.includes("delete")) return plan("experience_receiver", "search_experiences", { query: "WEEX" }, "Search experiences before deletion.");
    return plan("experience_receiver", "list_experiences", {}, "List experiences.");
  }

  private architect(message: string, payload: Record<string, unknown>): Record<string, unknown> {
    const clientState = typeof payload.clientState === "object" && payload.clientState !== null ? payload.clientState as Record<string, unknown> : {};
    if (message.includes("export")) return plan("architect", "export_resume", { resumeId: clientState.activeResumeId ?? "resume-1", format: "html" }, "Export resume after confirmation.");
    return plan("architect", "generate_resume_from_jd", { jdText: message || "JD", targetRole: "Target Role" }, "Generate resume after confirmation.");
  }
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

function plan(agentName: string, toolName: string, args: Record<string, unknown>, summary: string): Record<string, unknown> {
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
