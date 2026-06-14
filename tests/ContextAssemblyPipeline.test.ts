import { afterEach, describe, expect, it } from "vitest";
import type { ContextProvider } from "../src/agent-core/context/ContextProvider.js";
import { AgentCapabilityRegistry } from "../src/agent-core/capabilities/AgentCapabilityRegistry.js";
import { createDefaultCapabilities } from "../src/agent-core/capabilities/defaultCapabilities.js";
import { ContextAssemblyPipeline } from "../src/agent-core/context/ContextAssemblyPipeline.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createTestKernelContext } from "../src/api/context.js";
import type { ApiKernel } from "../src/api/types.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("ContextAssemblyPipeline", () => {
  let kernel: ApiKernel | undefined;

  afterEach(async () => {
    await kernel?.close();
    kernel = undefined;
  });

  it("assembles RunState while preserving default productContext with Noop capabilities", async () => {
    kernel = await createP12Kernel();
    const tools = new ToolRegistry();
    const pipeline = new ContextAssemblyPipeline({
      kernel,
      tools,
      capabilityRegistry: new AgentCapabilityRegistry(createDefaultCapabilities()),
    });
    const productContext = {
      targetRole: "Frontend Engineer",
      hasJDText: true,
      requestJDText: "React TypeScript role.",
    };

    const run = await pipeline.assemble({
      ctx: createTestKernelContext({ user: { id: "context-user" }, request: { requestId: "context-req", traceId: "context-trace" } }),
      sessionId: "context-session",
      turnId: "context-turn",
      userMessage: "Build context.",
      request: { message: "Build context.", clientState: { activeJDId: "pjd-1" } },
      productContext,
    });

    expect(run.context.productContext).toBe(productContext);
    expect(run.context.productContext).toMatchObject({
      targetRole: "Frontend Engineer",
      hasJDText: true,
      requestJDText: "React TypeScript role.",
    });
    expect(run.context.sessionId).toBe("context-session");
    expect(run.context.turnId).toBe("context-turn");
    expect(run.context.recentMessages).toEqual([]);
    expect(run.context.availableTools).toEqual([]);
    expect(run.trace.trace.steps.some((step) => step.summary === "Built user asset manifest.")).toBe(true);
  });

  it("places capability context provider output under productContext.capabilities.context", async () => {
    kernel = await createP12Kernel();
    const tools = new ToolRegistry();
    const provider: ContextProvider = {
      provide: async () => ({
        retrievalPreview: { enabled: false },
        memoryPreview: { enabled: false },
      }),
    };
    const pipeline = new ContextAssemblyPipeline({
      kernel,
      tools,
      capabilityRegistry: new AgentCapabilityRegistry([
        {
          id: "test.context",
          contextProviders: [provider],
        },
      ]),
    });

    const run = await pipeline.assemble({
      ctx: createTestKernelContext({ user: { id: "provider-user" }, request: { requestId: "provider-req", traceId: "provider-trace" } }),
      sessionId: "provider-session",
      turnId: "provider-turn",
      userMessage: "Build context with provider.",
      request: { message: "Build context with provider." },
      productContext: {
        targetRole: "Product Manager",
        capabilities: {
          retrieval: { existing: true },
          context: { existingContext: true },
        },
      },
    });

    expect(run.context.productContext).toMatchObject({
      targetRole: "Product Manager",
      capabilities: {
        retrieval: { existing: true },
        context: {
          existingContext: true,
          retrievalPreview: { enabled: false },
          memoryPreview: { enabled: false },
        },
      },
    });
    expect(run.context.productContext).not.toHaveProperty("retrievalPreview");
    expect(run.context.productContext).not.toHaveProperty("memoryPreview");
  });
});
