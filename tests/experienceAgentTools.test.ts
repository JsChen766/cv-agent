import { describe, expect, it } from "vitest";
import { createExperienceAgentTools } from "../src/agent-tools/experience/index.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

describe("P12 experience tools", () => {
  it("lists, searches, gets, saves, updates, and deletes real experiences", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    for (const name of ["save_experience_from_text", "update_experience", "delete_experience"]) {
      expect(registry.get(name)?.requiresConfirmation).toBe(true);
    }

    const initial = await executor.execute("list_experiences", {}, context);
    expect((initial.data as { count: number }).count).toBe(0);

    const prepared = await executor.execute("prepare_save_experience_from_text", { text: "WEEX data analysis dashboard with SQL." }, context);
    expect(prepared.status).toBe("success");
    expect(prepared.actionResult?.status).toBe("success");
    expect(prepared.actionResult?.actionType).toBe("prepare_save_experience_from_text");
    expect(prepared.actionResult?.status).not.toBe("needs_confirmation");
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(0);

    const saved = await executor.execute("save_experience_from_text", {
      text: "2026.01 - 2026.04\nWEEX Exchange Data Analyst Intern\nBuilt growth dashboards with SQL and Python.",
    }, context);
    const experienceId = (saved.data as { experienceId: string }).experienceId;
    expect(experienceId).toMatch(/^pexp-/);
    const savedData = saved.data as {
      draft: {
        category: string;
        organization?: string;
        role?: string;
        startDate?: string;
        endDate?: string;
        tags: string[];
      };
    };
    expect(savedData.draft.category).toBe("work");
    expect(savedData.draft.organization).toContain("WEEX");
    expect(savedData.draft.role?.toLowerCase()).toMatch(/intern|analyst/);
    expect(savedData.draft.startDate).toBe("2026-01");
    expect(savedData.draft.endDate).toBe("2026-04");
    expect(savedData.draft.tags).toEqual(expect.arrayContaining(["sql", "python"]));
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(1);

    expect((await executor.execute("search_experiences", { query: "WEEX" }, context)).status).toBe("success");
    expect((await executor.execute("get_experience", { id: experienceId }, context)).status).toBe("success");

    // prepare_update_experience is a read tool; it must NOT return needs_confirmation
    const preparedUpdate = await executor.execute("prepare_update_experience", { experienceId, content: "Updated content" }, context);
    expect(preparedUpdate.status).toBe("success");
    expect(preparedUpdate.actionResult?.status).toBe("success");
    expect(preparedUpdate.actionResult?.status).not.toBe("needs_confirmation");
    expect(preparedUpdate.actionResult?.actionType).toBe("prepare_update_experience");
    expect(preparedUpdate.pendingActionId).toBeUndefined();

    expect((await executor.execute("update_experience", { experienceId, patch: { title: "WEEX analytics" }, content: "Updated content" }, context)).status).toBe("success");

    // Empty update guard: update_experience with no patch and no content returns needs_input
    const emptyUpdate = await executor.execute("update_experience", { experienceId, patch: {} }, context);
    expect(emptyUpdate.status).toBe("needs_input");
    expect(emptyUpdate.actionResult?.status).toBe("needs_input");
    expect(emptyUpdate.actionResult?.missingInputs).toContain("content");
    // Verify no revision was created
    const revisions = await kernel.productServices.experienceService.listRevisions("user-1", experienceId as string);
    // Should still have the original revision created during save + update with content
    expect(revisions.length).toBeGreaterThanOrEqual(1);

    const updateWithContent = await executor.execute("update_experience", { experienceId, content: "Improved content with metrics" }, context);
    expect(updateWithContent.status).toBe("success");
    const metadata = (updateWithContent.actionResult as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.revisionId).toBeTruthy();

    expect((await executor.execute("delete_experience", { experienceId }, context)).status).toBe("success");
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(0);
    await kernel.close();
  });

  it("extracts education structure from save_experience_from_text", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("save_experience_from_text", {
      text: "Sun Yat-sen University\nBachelor in Computer Science, GPA 3.8/4.0\nMajor: Computer Science",
    }, context);
    const data = result.data as {
      draft: {
        category: string;
        organization?: string;
        structured: Record<string, unknown>;
      };
    };
    expect(data.draft.category).toBe("education");
    expect(data.draft.organization).toContain("University");
    expect(data.draft.structured.major).toBe("Computer Science");
    expect(String(data.draft.structured.degree)).toContain("Bachelor");
    await kernel.close();
  });

  it("extracts project structure and tech stack from save_experience_from_text", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("save_experience_from_text", {
      text: "Project: Resume Copilot Platform\nProject role: Full Stack Developer\nBuilt a React + Node + SQL platform for resume generation.",
    }, context);
    const data = result.data as {
      draft: {
        category: string;
        title: string;
        structured: Record<string, unknown>;
      };
    };
    expect(data.draft.category).toBe("project");
    expect(data.draft.title).toContain("Resume Copilot Platform");
    expect(data.draft.structured.projectName).toContain("Resume Copilot Platform");
    expect(data.draft.structured.techStack).toEqual(expect.arrayContaining(["react", "node", "sql"]));
    await kernel.close();
  });
});
