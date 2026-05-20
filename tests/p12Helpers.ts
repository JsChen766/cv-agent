import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import type { AgentContext } from "../src/agent-core/runtime/AgentContext.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import type { ToolDefinition } from "../src/agent-core/tools/Tool.js";
import { createTestKernelContext } from "../src/kernel/context.js";

export function setupP12Env(): void {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.FRONTDESK_AGENT_MODE = "mock";
  process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
  process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
  process.env.CRITIC_AGENT_MODE = "deterministic";
  process.env.REVISION_AGENT_MODE = "deterministic";
  process.env.NODE_ENV = "test";
  delete process.env.DATABASE_URL;
}

export async function createP12Kernel(): Promise<ApiKernel> {
  setupP12Env();
  return createKernel();
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
