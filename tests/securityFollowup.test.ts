import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PendingActionService } from "../src/agent-core/confirmation/PendingActionService.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { guardToolIds } from "../src/agent-core/security/ToolIdGuard.js";
import { guardToolScope } from "../src/agent-core/security/ToolScopeGuard.js";
import { sanitizeExperiencePatch } from "../src/agent-core/security/ToolPatchSanitizer.js";
import type { AgentContext } from "../src/agent-core/runtime/AgentContext.js";
import type { ToolDefinition } from "../src/agent-core/tools/Tool.js";
import { ToolResultSchema } from "../src/agent-core/validation/ToolInputSchemas.js";
import { createEvidenceAgentTools } from "../src/agent-tools/evidence/index.js";
import { prepareUpdateExperienceTool } from "../src/agent-tools/experience/prepareUpdateExperience.tool.js";
import { updateExperienceTool } from "../src/agent-tools/experience/updateExperience.tool.js";
import type { ApiKernel } from "../src/api/types.js";
import { ContextHydrator } from "../src/copilot/context/ContextHydrator.js";
import type { CopilotWorkspace, ProductVariant } from "../src/copilot/types.js";
import type { ProductResumeDetail } from "../src/product/types.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

const PEXP_A = "pexp-00000000-0000-0000-0000-000000000001";
const PEXP_B = "pexp-00000000-0000-0000-0000-000000000002";
const PVAR_A = "pvar-00000000-0000-0000-0000-000000000001";
const PVAR_B = "pvar-00000000-0000-0000-0000-000000000002";
const PGEN_A = "pgen-00000000-0000-0000-0000-000000000001";
const PITEM_A = "presitem-00000000-0000-0000-0000-000000000001";
const PITEM_B = "presitem-00000000-0000-0000-0000-000000000002";

describe("P0.1 security follow-up regressions", () => {
  let kernel: ApiKernel;

  beforeEach(async () => {
    kernel = await createP12Kernel();
  });

  afterEach(async () => {
    await kernel.close();
  });

  it("does not hydrate update_experience content from selected or active reference text", () => {
    const hydrator = new ContextHydrator();
    const context = {
      ...testContext(kernel),
      clientState: { activeExperienceId: PEXP_A, selectedText: "selected reference" },
      activeAssetContext: { activeExperience: { id: PEXP_A, title: "Active", contentPreview: "active reference" } },
    } as AgentContext;
    const workspace = baseWorkspace({ active: { experienceId: PEXP_A } });

    const hydrated = hydrator.hydrate("update_experience", { instruction: "rewrite this" }, context, workspace);

    expect(hydrated.experienceId).toBe(PEXP_A);
    expect(hydrated.content).toBeUndefined();
  });

  it("hydrates update_experience only from explicit rewrite fields", () => {
    const hydrator = new ContextHydrator();
    const context = testContext(kernel);

    expect(hydrator.hydrate("update_experience", { experienceId: PEXP_A, rewrittenText: "rewritten" }, context, null).content).toBe("rewritten");
    expect(hydrator.hydrate("update_experience", { experienceId: PEXP_A, after: "after text" }, context, null).content).toBe("after text");
    expect(hydrator.hydrate("update_experience", { experienceId: PEXP_A, content: "content text" }, context, null).content).toBe("content text");
  });

  it("prepare_update_experience ignores patch.content and illegal-only patches", async () => {
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", { title: "Patch test", content: "Original revision" });
    const context = testContext(kernel);
    const tool = prepareUpdateExperienceTool();

    const contentPatch = await tool.execute({ experienceId: experience.id, patch: { content: "polluted" } }, context);
    expect(contentPatch.status).toBe("needs_input");

    const undefinedPatch = await tool.execute({ experienceId: experience.id, patch: { content: undefined } }, context);
    expect(undefinedPatch.status).toBe("needs_input");
  });

  it("sanitizes illegal patch keys while allowing safe title updates", async () => {
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", { title: "Old title", content: "Original revision" });
    const context = testContext(kernel);
    const update = updateExperienceTool();

    const result = await update.execute({ experienceId: experience.id, patch: { userId: "other", id: PEXP_B, title: "New title" } }, context);
    const stored = await kernel.productServices.experienceService.getExperience("user-1", experience.id);

    expect(result.status).toBe("success");
    expect(stored?.title).toBe("New title");
    expect(stored?.userId).toBe("user-1");
  });

  it("treats array and null patches as empty patches", async () => {
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", { title: "Array patch", content: "Original revision" });
    const context = testContext(kernel);
    const tool = prepareUpdateExperienceTool();

    expect((await tool.execute({ experienceId: experience.id, patch: [] }, context)).status).toBe("needs_input");
    expect((await tool.execute({ experienceId: experience.id, patch: null }, context)).status).toBe("needs_input");
  });

  it("normalizes show_evidence id semantics and does not fallback from generationId to first variant", async () => {
    const tool = createEvidenceAgentTools().find((item) => item.name === "show_evidence")!;
    const context = {
      ...testContext(kernel),
      workspace: baseWorkspace({
        productGenerationId: PGEN_A,
        variants: [variantWithEvidence(PVAR_A, PEXP_A)],
      }),
    } as AgentContext;

    const byVariant = await tool.execute({ id: PVAR_A }, context);
    const byEvidence = await tool.execute({ id: PEXP_A }, context);
    const byGeneration = await tool.execute({ id: PGEN_A }, context);

    expect(byVariant.status).toBe("success");
    expect(byEvidence.status).toBe("success");
    expect(byGeneration.status).toBe("needs_input");
    expect(byGeneration.actionResult?.reason).toBe("generation_evidence_lookup_not_supported");
  });

  it("does not hydrate show_evidence generation-only targets with active variant fallback", () => {
    const hydrator = new ContextHydrator();
    const context = { ...testContext(kernel), clientState: { activeVariantId: PVAR_A } } as AgentContext;
    const workspace = baseWorkspace({ activeVariantId: PVAR_A, active: { variantId: PVAR_A }, variants: [variantWithEvidence(PVAR_A, PEXP_A)] });

    const byId = hydrator.hydrate("show_evidence", { id: PGEN_A }, context, workspace);
    const byGeneration = hydrator.hydrate("show_evidence", { generationId: PGEN_A }, context, workspace);

    expect(byId.generationId).toBe(PGEN_A);
    expect(byId.variantId).toBeUndefined();
    expect(byGeneration.generationId).toBe(PGEN_A);
    expect(byGeneration.variantId).toBeUndefined();
  });

  it("hydrates show_evidence from active variant only when no evidence target is explicit", async () => {
    const hydrator = new ContextHydrator();
    const tool = createEvidenceAgentTools().find((item) => item.name === "show_evidence")!;
    const workspace = baseWorkspace({ activeVariantId: PVAR_A, active: { variantId: PVAR_A }, variants: [variantWithEvidence(PVAR_A, PEXP_A)] });
    const context = { ...testContext(kernel), workspace } as AgentContext;

    const hydrated = hydrator.hydrate("show_evidence", {}, context, workspace);
    const result = await tool.execute(hydrated, context);

    expect(hydrated.variantId).toBe(PVAR_A);
    expect(result.status).toBe("success");
  });

  it("keeps explicit show_evidence variant targets and rejects invalid ids", async () => {
    const hydrator = new ContextHydrator();
    const tool = createEvidenceAgentTools().find((item) => item.name === "show_evidence")!;
    const workspace = baseWorkspace({ activeVariantId: PVAR_B, variants: [variantWithEvidence(PVAR_A, PEXP_A), variantWithEvidence(PVAR_B, PEXP_B)] });
    const context = { ...testContext(kernel), workspace } as AgentContext;

    const hydrated = hydrator.hydrate("show_evidence", { variantId: PVAR_A }, context, workspace);
    const result = await tool.execute(hydrated, context);
    const invalid = guardToolIds("show_evidence", { id: "not-a-real-id" });

    expect(hydrated.variantId).toBe(PVAR_A);
    expect(result.status).toBe("success");
    expect(invalid).toMatchObject({ status: "needs_input", actionResult: { missingInputs: ["id"] } });
  });

  it("rejects write conflicts between explicit IDs and active workspace IDs", async () => {
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = testContext(kernel).requestContext;
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const expA = await kernel.productServices.experienceService.createExperience("user-1", { title: "A", content: "A" });
    const expB = await kernel.productServices.experienceService.createExperience("user-1", { title: "B", content: "B" });

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "rewrite_experience", payload: { experienceId: expB.experience.id, content: "rewrite" } },
      clientState: { activeExperienceId: expA.experience.id },
    });

    expect(result.raw.pendingActions ?? []).toHaveLength(0);
    expect(result.raw.actionResults?.[0]).toMatchObject({ status: "needs_input" });
    expect(JSON.stringify(result.raw.agentTrace)).toContain("Resolver detected conflicting IDs");
  });

  it("confirmPendingAction revalidates canonical IDs and does not execute blocked tools", async () => {
    const pendingActions = new PendingActionService();
    const runtime = new AgentOrchestrator({ kernel, pendingActions });
    let executeCount = 0;
    const tool = countingTool("update_experience", () => { executeCount += 1; });
    runtime.tools.register(tool);
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const action = await pendingActions.create({
      userId: "user-1",
      sessionId: session.id,
      tool,
      toolArguments: { experienceId: "weex", content: "rewrite" },
    });

    const response = await runtime.confirmPendingAction(testContext(kernel).requestContext, action.id);
    const stored = await pendingActions.get("user-1", action.id);

    expect(executeCount).toBe(0);
    expect(stored?.status).toBe("failed");
    expect(response.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", reason: "confirm_guard_blocked" });
  });

  it("confirmPendingAction revalidates scope for canonical but nonexistent experience IDs", async () => {
    const pendingActions = new PendingActionService();
    const runtime = new AgentOrchestrator({ kernel, pendingActions });
    let executeCount = 0;
    const tool = countingTool("update_experience", () => { executeCount += 1; });
    runtime.tools.register(tool);
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const action = await pendingActions.create({
      userId: "user-1",
      sessionId: session.id,
      tool,
      toolArguments: { experienceId: PEXP_A, content: "rewrite" },
    });

    const response = await runtime.confirmPendingAction(testContext(kernel).requestContext, action.id);
    const stored = await pendingActions.get("user-1", action.id);

    expect(executeCount).toBe(0);
    expect(stored?.status).toBe("failed");
    expect(response.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", reason: "confirm_guard_blocked" });
  });

  it("confirmPendingAction revalidates generation session scope", async () => {
    const pendingActions = new PendingActionService();
    const runtime = new AgentOrchestrator({ kernel, pendingActions });
    let executeCount = 0;
    const tool: ToolDefinition = {
      ...countingTool("accept_generation_variant", () => { executeCount += 1; }),
      inputSchema: z.object({ generationId: z.string(), variantId: z.string() }).passthrough(),
    };
    runtime.tools.register(tool);
    const otherSession = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const currentSession = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const generated = await kernel.productServices.generationProductService.generateResumeFromJD({
      userId: "user-1",
      sessionId: otherSession.id,
      jdText: "JD",
    });
    const action = await pendingActions.create({
      userId: "user-1",
      sessionId: currentSession.id,
      tool,
      toolArguments: { generationId: generated.generation.id, variantId: generated.variants[0]!.id },
    });

    const response = await runtime.confirmPendingAction(testContext(kernel).requestContext, action.id);
    const stored = await pendingActions.get("user-1", action.id);

    expect(executeCount).toBe(0);
    expect(stored?.status).toBe("failed");
    expect(response.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", reason: "confirm_guard_blocked" });
  });

  it("export_resume with nonexistent resumeId is blocked before executor runs", async () => {
    const runtime = new AgentOrchestrator({ kernel });
    let executeCount = 0;
    runtime.tools.register({
      ...countingTool("export_resume", () => { executeCount += 1; }),
      inputSchema: z.object({ resumeId: z.string(), format: z.string().optional() }).passthrough(),
    });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(testContext(kernel).requestContext, {
      sessionId: session.id,
      action: { type: "export_resume", payload: { resumeId: "pres-00000000-0000-0000-0000-000000000099" } },
    });

    expect(executeCount).toBe(0);
    expect(result.raw.pendingActions ?? []).toHaveLength(0);
    expect(result.raw.actionResults?.[0]).toMatchObject({ status: "needs_input" });
  });

  it("guards revise_resume_item resumeItemId format", () => {
    expect(guardToolIds("revise_resume_item", { resumeItemId: "abc", instruction: "rewrite" })).toMatchObject({
      status: "needs_input",
      actionResult: { missingInputs: ["resumeItemId"] },
    });
    expect(guardToolIds("revise_resume_item", { resumeItemId: PITEM_A, instruction: "rewrite" })).toBeUndefined();
  });

  it("guards revise_resume_item workspace scope", async () => {
    const context = testContext(kernel);
    const missingResume = await guardToolScope("revise_resume_item", { resumeItemId: PITEM_A, instruction: "rewrite" }, context, null);
    const wrongItem = await guardToolScope("revise_resume_item", { resumeItemId: PITEM_B, instruction: "rewrite" }, context, baseWorkspace({ activeResume: activeResumeWithItem(PITEM_A) }));
    const valid = await guardToolScope("revise_resume_item", { resumeItemId: PITEM_A, instruction: "rewrite" }, context, baseWorkspace({ activeResume: activeResumeWithItem(PITEM_A) }));

    expect(missingResume).toMatchObject({ status: "needs_input", actionResult: { missingInputs: ["resumeItemId"] } });
    expect(wrongItem).toMatchObject({ status: "needs_input", actionResult: { missingInputs: ["resumeItemId"] } });
    expect(valid).toBeUndefined();
  });

  it("does not create a revise_resume_item pending action for illegal resumeItemId", async () => {
    const runtime = new AgentOrchestrator({ kernel });
    let executeCount = 0;
    runtime.tools.register({
      ...countingTool("revise_resume_item", () => { executeCount += 1; }),
      inputSchema: z.object({ resumeItemId: z.string(), instruction: z.string() }).passthrough(),
    });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(testContext(kernel).requestContext, {
      sessionId: session.id,
      action: { type: "optimize_resume_item", payload: { resumeItemId: "abc", instruction: "rewrite" } },
    });

    expect(executeCount).toBe(0);
    expect(result.raw.pendingActions ?? []).toHaveLength(0);
    expect(result.raw.actionResults?.[0]).toMatchObject({ status: "needs_input" });
  });

  it("sanitizes experience patch keys and values conservatively", () => {
    expect(sanitizeExperiencePatch({ description: "x" })).toEqual({});
    expect(sanitizeExperiencePatch({ summary: "x" })).toEqual({});
    expect(sanitizeExperiencePatch({ location: "x" })).toEqual({});
    expect(sanitizeExperiencePatch({ userId: "other" })).toEqual({});
    expect(sanitizeExperiencePatch({ currentRevisionId: "xxx" })).toEqual({});
    expect(sanitizeExperiencePatch({ title: "  New Title  " })).toEqual({ title: "New Title" });
    expect(sanitizeExperiencePatch({ category: "bad" })).toEqual({});
    expect(sanitizeExperiencePatch({ tags: ["sql", "", "sql", " data "] })).toEqual({ tags: ["sql", "data"] });
  });

  it("returns needs_input when experience patch only has illegal fields", async () => {
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", { title: "Illegal patch", content: "Original" });
    const context = testContext(kernel);

    expect((await prepareUpdateExperienceTool().execute({ experienceId: experience.id, patch: { description: "x" } }, context)).status).toBe("needs_input");
    expect((await updateExperienceTool().execute({ experienceId: experience.id, patch: { summary: "x" } }, context)).status).toBe("needs_input");
  });

  it("marks confirm schema blocks as blocked in trace and response", async () => {
    const pendingActions = new PendingActionService();
    const runtime = new AgentOrchestrator({ kernel, pendingActions });
    let executeCount = 0;
    const tool: ToolDefinition = {
      ...countingTool("update_experience", () => { executeCount += 1; }),
      inputSchema: z.object({ experienceId: z.string(), content: z.string() }).passthrough(),
    };
    runtime.tools.register(tool);
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const action = await pendingActions.create({
      userId: "user-1",
      sessionId: session.id,
      tool,
      toolArguments: { content: "rewrite" },
    });

    const response = await runtime.confirmPendingAction(testContext(kernel).requestContext, action.id);
    const trace = JSON.stringify(response.raw.agentTrace);

    expect(executeCount).toBe(0);
    expect(trace).toContain(`Blocked pending action ${action.id}.`);
    expect(trace).not.toContain(`Executed pending action ${action.id}.`);
    expect(response.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", reason: "confirm_schema_blocked" });
    expect(response.assistantMessage.content).toBe("Pending action input is invalid. Please start the action again.");
    expect((response.workspace as Record<string, unknown>).activePanel).toBeUndefined();
    expect(trace).not.toContain("Critic pass.");
  });

  it("marks confirm guard blocks as blocked in trace", async () => {
    const pendingActions = new PendingActionService();
    const runtime = new AgentOrchestrator({ kernel, pendingActions });
    const tool = countingTool("update_experience", () => {});
    runtime.tools.register(tool);
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const action = await pendingActions.create({
      userId: "user-1",
      sessionId: session.id,
      tool,
      toolArguments: { experienceId: "abc", content: "rewrite" },
    });

    const response = await runtime.confirmPendingAction(testContext(kernel).requestContext, action.id);
    const trace = JSON.stringify(response.raw.agentTrace);

    expect(trace).toContain(`Blocked pending action ${action.id}.`);
    expect(trace).not.toContain(`Executed pending action ${action.id}.`);
    expect(response.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", reason: "confirm_guard_blocked" });
  });
});

function countingTool(name: string, onExecute: () => void): ToolDefinition {
  return {
    name,
    description: "Counting test tool.",
    ownerAgent: name === "update_experience" ? "experience_receiver" : "architect",
    inputSchema: z.object({}).passthrough(),
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async () => {
      onExecute();
      return { status: "success", message: "executed" };
    },
  };
}

function baseWorkspace(overrides: Partial<CopilotWorkspace> = {}): CopilotWorkspace {
  return {
    id: "ws-test",
    sessionId: "cs-test",
    variants: [],
    status: "ready",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function variantWithEvidence(id: string, evidenceId: string): ProductVariant {
  return {
    id,
    artifactId: null,
    title: "Variant",
    content: "Content",
    role: "recommended",
    status: "ready",
    score: {},
    badges: [],
    reason: "Test",
    evidenceSummary: {
      coverageLabel: "Covered",
      items: [{ id: evidenceId, title: "Evidence", explanation: "Used as evidence." }],
    },
    riskSummary: { level: "low", unsupportedClaims: [], missingEvidence: [], warnings: [] },
    missingInfo: [],
    sourceExperienceIds: [evidenceId],
    sourceEvidenceIds: [],
    actions: [],
    raw: {},
    createdAt: new Date().toISOString(),
  };
}

function activeResumeWithItem(itemId: string): ProductResumeDetail {
  const now = new Date().toISOString();
  return {
    id: "pres-00000000-0000-0000-0000-000000000001",
    userId: "user-1",
    title: "Resume",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    items: [{
      id: itemId,
      resumeId: "pres-00000000-0000-0000-0000-000000000001",
      userId: "user-1",
      sectionType: "experience",
      title: "Item",
      contentSnapshot: "Built data pipelines.",
      orderIndex: 0,
      hidden: false,
      pinned: false,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    }],
  };
}
