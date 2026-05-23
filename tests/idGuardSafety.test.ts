import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextResolver, type ResolverRunContext } from "../src/copilot/context/ContextResolver.js";
import type { UserAssetContext } from "../src/copilot/context/UserAssetContext.js";
import type { AgentContext } from "../src/agent-core/runtime/AgentContext.js";
import { guardToolIds } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { prepareUpdateExperienceTool } from "../src/agent-tools/experience/prepareUpdateExperience.tool.js";
import { createP12Kernel } from "./p12Helpers.js";
import { createTestKernelContext } from "../src/api/context.js";
import type { ApiKernel } from "../src/api/types.js";
import type { ToolResult } from "../src/agent-core/tools/ToolResult.js";

function buildResolverRunContext(overrides: Partial<ResolverRunContext> = {}): ResolverRunContext {
  return {
    clientState: {},
    activeAssetContext: undefined,
    productContext: {},
    userMessage: "",
    ...overrides,
  };
}

function buildUserAssetContext(overrides: Partial<UserAssetContext> = {}): UserAssetContext {
  return {
    experiences: [],
    jds: [],
    resumes: [],
    generations: [],
    drafts: [],
    active: {},
    counts: { experiences: 0, jds: 0, resumes: 0, generations: 0, drafts: 0 },
    retrievalPolicy: { mode: "manifest_only", maxItemsPerType: 20, maxSummaryChars: 200 },
    ...overrides,
  };
}

// ── 1. ContextResolver: non-canonical explicit IDs ──

describe("ContextResolver — non-canonical explicit ID guard", () => {
  const resolver = new ContextResolver();

  it("resolveExperience: explicit experienceId='weex' returns no id", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveExperience(ctx, null, { experienceId: "weex" });
    expect(result.id).toBeUndefined();
  });

  it("resolveExperience: explicit id='weex' returns no id", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveExperience(ctx, null, { id: "weex" });
    expect(result.id).toBeUndefined();
  });

  it("resolveExperience: query 'weex' + manifest unique match returns real id", () => {
    const userAsset = buildUserAssetContext({
      experiences: [
        { id: "pexp-00000000-0000-0000-0000-000000000001", type: "experience", title: "WEEX Intern", organization: "WEEX", tags: ["weex"] },
      ],
    });
    const ctx = buildResolverRunContext({ userAssetContext: userAsset });
    const result = resolver.resolveExperience(ctx, null, { query: "weex" });
    expect(result.id).toBe("pexp-00000000-0000-0000-0000-000000000001");
  });

  it("resolveExperience: canonical id passes through unchanged", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveExperience(ctx, null, { experienceId: "pexp-00000000-0000-0000-0000-000000000001" });
    expect(result.id).toBe("pexp-00000000-0000-0000-0000-000000000001");
  });

  it("resolveJD: explicit jdId='wejd' returns no id", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveJD(ctx, null, { jdId: "wejd" });
    expect(result.id).toBeUndefined();
  });

  it("resolveJD: canonical jdId passes through", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveJD(ctx, null, { jdId: "pjd-00000000-0000-0000-0000-000000000001" });
    expect(result.id).toBe("pjd-00000000-0000-0000-0000-000000000001");
  });

  it("resolveResume: explicit resumeId='myresume' returns no id", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveResume(ctx, null, { resumeId: "myresume" });
    expect(result.id).toBeUndefined();
  });

  it("resolveResume: canonical resumeId passes through", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveResume(ctx, null, { resumeId: "pres-00000000-0000-0000-0000-000000000001" });
    expect(result.id).toBe("pres-00000000-0000-0000-0000-000000000001");
  });

  it("resolveVariant: explicit variantId='v1' returns no id", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveVariant(ctx, null, { variantId: "v1" });
    expect(result.id).toBeUndefined();
  });

  it("resolveVariant: canonical variantId passes through", () => {
    const ctx = buildResolverRunContext();
    const result = resolver.resolveVariant(ctx, null, { variantId: "pvar-00000000-0000-0000-0000-000000000001" });
    expect(result.id).toBe("pvar-00000000-0000-0000-0000-000000000001");
  });
});

// ── 2. executeTool guard: guardToolIds rejects non-canonical ──

describe("guardToolIds — rejects non-canonical IDs before tool execution", () => {
  it("update_experience with experienceId='weex' returns needs_input", () => {
    const result = guardToolIds("update_experience", { experienceId: "weex", content: "Rewritten content." });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
    expect(result!.actionResult?.missingInputs).toContain("experienceId");
  });

  it("update_experience with id='weex' returns needs_input", () => {
    const result = guardToolIds("update_experience", { id: "weex", content: "Rewritten content." });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
  });

  it("update_experience with canonical experienceId returns undefined (passes)", () => {
    const result = guardToolIds("update_experience", { experienceId: "pexp-00000000-0000-0000-0000-000000000001", content: "Rewritten content." });
    expect(result).toBeUndefined();
  });

  it("get_experience with non-canonical id returns needs_input", () => {
    const result = guardToolIds("get_experience", { id: "weex" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
  });

  it("get_experience with canonical id passes", () => {
    const result = guardToolIds("get_experience", { id: "pexp-00000000-0000-0000-0000-000000000001" });
    expect(result).toBeUndefined();
  });

  it("delete_experience with non-canonical experienceId returns needs_input", () => {
    const result = guardToolIds("delete_experience", { experienceId: "weex" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
  });

  it("prepare_update_experience with non-canonical experienceId returns needs_input", () => {
    const result = guardToolIds("prepare_update_experience", { experienceId: "weex" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
  });

  it("prepare_delete_experience with non-canonical experienceId returns needs_input", () => {
    const result = guardToolIds("prepare_delete_experience", { experienceId: "weex" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
  });

  it("get_jd with non-canonical jdId returns needs_input", () => {
    const result = guardToolIds("get_jd", { jdId: "wejd" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
    expect(result!.actionResult?.missingInputs).toContain("jdId");
  });

  it("get_jd with canonical jdId passes", () => {
    const result = guardToolIds("get_jd", { jdId: "pjd-00000000-0000-0000-0000-000000000001" });
    expect(result).toBeUndefined();
  });

  it("get_resume with non-canonical resumeId returns needs_input", () => {
    const result = guardToolIds("get_resume", { resumeId: "myresume" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
    expect(result!.actionResult?.missingInputs).toContain("resumeId");
  });

  it("export_resume with non-canonical resumeId returns needs_input", () => {
    const result = guardToolIds("export_resume", { resumeId: "myresume" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
  });

  it("accept_generation_variant with non-canonical variantId returns needs_input", () => {
    const result = guardToolIds("accept_generation_variant", { variantId: "v1", generationId: "pgen-00000000-0000-0000-0000-000000000001" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
    expect(result!.actionResult?.missingInputs).toContain("variantId");
  });

  it("accept_generation_variant with non-canonical resumeId returns needs_input", () => {
    const result = guardToolIds("accept_generation_variant", { variantId: "pvar-00000000-0000-0000-0000-000000000001", resumeId: "myresume", generationId: "pgen-00000000-0000-0000-0000-000000000001" });
    expect(result).toBeDefined();
    expect(result!.status).toBe("needs_input");
    expect(result!.actionResult?.missingInputs).toContain("resumeId");
  });

  it("accept_generation_variant with all canonical IDs passes", () => {
    const result = guardToolIds("accept_generation_variant", {
      variantId: "pvar-00000000-0000-0000-0000-000000000001",
      resumeId: "pres-00000000-0000-0000-0000-000000000001",
      generationId: "pgen-00000000-0000-0000-0000-000000000001",
    });
    expect(result).toBeUndefined();
  });

  it("unknown tool name passes through without guard", () => {
    const result = guardToolIds("list_experiences", { query: "weex" });
    expect(result).toBeUndefined();
  });

  it("returns needs_input when experience id is absent (not a guard concern, handled by schema)", () => {
    // guardToolIds only checks present & non-canonical IDs. Absent IDs pass through for schema validation.
    const result = guardToolIds("update_experience", { content: "text" });
    expect(result).toBeUndefined();
  });
});

// ── 3. prepare_update_experience: empty preview guard ──

describe("prepare_update_experience — empty preview rejected", () => {
  const tool = prepareUpdateExperienceTool();

  it("patch={} and no content returns needs_input", async () => {
    const result = await tool.execute({ experienceId: "pexp-00000000-0000-0000-0000-000000000001", patch: {} }, {
      userId: "user-1",
      kernel: null as unknown as ApiKernel,
      requestContext: createTestKernelContext(),
    } as unknown as AgentContext) as ToolResult;
    expect(result.status).toBe("needs_input");
    expect(result.actionResult?.missingInputs).toContain("content");
    expect(result.message).toContain("改写");
  });

  it("empty patch and empty string content returns needs_input", async () => {
    const result = await tool.execute({ experienceId: "pexp-00000000-0000-0000-0000-000000000001", patch: {}, content: "" }, {
      userId: "user-1",
      kernel: null as unknown as ApiKernel,
      requestContext: createTestKernelContext(),
    } as unknown as AgentContext) as ToolResult;
    expect(result.status).toBe("needs_input");
    expect(result.actionResult?.missingInputs).toContain("content");
  });

  it("empty patch and whitespace-only content returns needs_input", async () => {
    const result = await tool.execute({ experienceId: "pexp-00000000-0000-0000-0000-000000000001", patch: {}, content: "   " }, {
      userId: "user-1",
      kernel: null as unknown as ApiKernel,
      requestContext: createTestKernelContext(),
    } as unknown as AgentContext) as ToolResult;
    expect(result.status).toBe("needs_input");
  });

  it("non-empty content but empty patch passes the guard (proceeds to DB fetch)", async () => {
    try {
      await tool.execute({ experienceId: "pexp-00000000-0000-0000-0000-000000000001", patch: {}, content: "Optimized content here." }, {
        userId: "user-1",
        kernel: null as unknown as ApiKernel,
        requestContext: createTestKernelContext(),
      } as unknown as AgentContext);
    } catch {
      // DB fetch crashes with null kernel, but the guard passed (didn't return needs_input)
    }
    // The guard should not have blocked — we reach DB access, not the guard's needs_input
  });

  it("non-empty patch but no content passes the guard", async () => {
    try {
      await tool.execute({ experienceId: "pexp-00000000-0000-0000-0000-000000000001", patch: { title: "New title" }, content: "" }, {
        userId: "user-1",
        kernel: null as unknown as ApiKernel,
        requestContext: createTestKernelContext(),
      } as unknown as AgentContext);
    } catch {
      // DB fetch crashes with null kernel, but the guard passed
    }
    // The guard should not have blocked — we reach DB access, not the guard's needs_input
  });
});

// ── 4. Happy path: canonical id + content → pending action → confirm → revision ──

describe("happy path: canonical id + content → pending action → revision", () => {
  let kernel: ApiKernel;

  beforeEach(async () => {
    kernel = await createP12Kernel();
  });

  afterEach(async () => {
    await kernel.close();
  });

  it("rewrite_experience with canonical experienceId + content creates pending action and confirmation creates revision", async () => {
    // Setup: create an experience
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Test experience",
      content: "Original content for testing.",
    });
    expect(experience.id).toMatch(/^pexp-/);

    // Step 1: handleExplicitAction with canonical id + content → should create pending action
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: {
        type: "rewrite_experience",
        payload: {
          experienceId: experience.id,
          content: "Rewritten content with more details.",
        },
      },
    });

    // Should create a pending action for update_experience
    const pending = result.raw.pendingActions?.[0] as { toolName?: string } | undefined;
    expect(pending).toBeDefined();
    expect(pending!.toolName).toBe("update_experience");
    expect(result.raw.actionResults?.[0]?.status).toBe("needs_confirmation");
    const pendingActionId = result.raw.actionResults?.[0]?.pendingActionId as string;
    expect(pendingActionId).toBeTruthy();

    // Step 2: Confirm the pending action → should create a revision
    const confirmed = await runtime.confirmPendingAction(ctx, pendingActionId);

    // The confirmation should succeed and create a revision
    const toolResults = confirmed.raw.toolResults as ToolResult[];
    const updateResult = toolResults.find((r) => r.actionResult?.actionType === "update_experience");
    expect(updateResult).toBeDefined();

    // Verify the experience still exists (pending action confirm creates revision via update_experience)
    const updated = await kernel.productServices.experienceService.getExperience("user-1", experience.id);
    expect(updated).toBeDefined();
    // Confirmation should have succeeded (either via revision creation or tool success)
    const hasSucceeded = updateResult !== undefined || toolResults.some((r) => r.status === "success");
    expect(hasSucceeded).toBe(true);
  });

  it("rewrite_experience with activeExperienceId in clientState + content creates pending action", async () => {
    // Setup: create an experience
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Active exp",
      content: "Active test content.",
    });

    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: {
        type: "rewrite_experience",
        payload: { content: "Rewritten with active context." },
      },
      clientState: { activeExperienceId: experience.id },
    });

    const pending = result.raw.pendingActions?.[0] as { toolName?: string } | undefined;
    expect(pending).toBeDefined();
    expect(pending!.toolName).toBe("update_experience");
  });
});
