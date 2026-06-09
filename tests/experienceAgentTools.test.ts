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

    // Get saved experience from DB to verify data integrity
    const exp = await kernel.productServices.experienceService.getExperience("user-1", experienceId);
    expect(exp).not.toBeNull();
    expect(exp!.category).toBeDefined();
    expect(exp!.title).toBeDefined();

    // Verify data was persisted
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

    expect(result.status).toBe("success");
    const data = result.data as { experienceId: string };
    expect(data.experienceId).toBeDefined();

    // Verify saved experience in DB
    const exp = await kernel.productServices.experienceService.getExperience("user-1", data.experienceId);
    expect(exp).not.toBeNull();
    expect(exp!.category).toBeDefined();
    expect(exp!.title).toBeDefined();
    await kernel.close();
  });

  it("saves save_experience_from_text with candidate only and no text", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("save_experience_from_text", {
      candidate: {
        category: "project",
        title: "Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition",
        content: "Published a first-author paper related to multimodal emotion recognition in Transactions on Multimedia.",
        tags: ["multimodal emotion recognition"],
        structured: {
          rawText: "First-author paper in Transactions on Multimedia.",
        },
      },
    }, context);

    expect(result.status).toBe("success");
    expect(result.actionResult?.actionType).toBe("save_experience_from_text");
    const data = result.data as { experienceId: string };
    expect(data.experienceId).toMatch(/^pexp-/);
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(1);
    await kernel.close();
  });

  it("returns needs_input for incomplete candidate without text instead of validation failure", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("save_experience_from_text", {
      candidate: {
        title: "Incomplete draft",
      },
    }, context);

    expect(result.status).toBe("needs_input");
    expect(result.actionResult?.status).toBe("needs_input");
    expect(result.actionResult?.reason).toBe("missing_experience_input");
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(0);
    await kernel.close();
  });

  it("does not require web search when text contains redundant online lookup instructions", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("save_experience_from_text", {
      text: "I published a paper as the first author in Transactions on Multimedia titled Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition. You can find more details online.",
    }, context);

    expect(result.status).toBe("success");
    const data = result.data as { warnings?: string[] };
    expect(data.warnings).toContain("External details are unverified and can be added later.");
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(1);
    await kernel.close();
  });

  it("imports editable education candidates from text without saving immediately", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("import_experience_candidates_from_text", {
      text: "Sun Yat-sen University\nBachelor in Computer Science, GPA 3.8/4.0\nMajor: Computer Science",
    }, context);

    expect(result.status).toBe("success");
    const data = result.data as { candidates: Array<{ id: string; category: string; structured?: Record<string, unknown> }>; formSchemaVersion: number; saveMode: string };
    expect(data.formSchemaVersion).toBe(1);
    expect(data.saveMode).toBe("accept_candidate");
    expect(data.candidates[0].id).toMatch(/^pimpcand-/);
    expect(data.candidates[0].category).toBe("education");
    expect(data.candidates[0].structured?.school).toBeDefined();
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(0);
    await kernel.close();
  });

  it("import_experience_candidates_from_text returns structured failure when candidate extraction throws", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());
    const original = kernel.productServices.importService.createCandidatesFromText.bind(kernel.productServices.importService);
    kernel.productServices.importService.createCandidatesFromText = async (userId: string, jobId: string) => {
      await kernel.productServices.importService.getImportJob(userId, jobId);
      throw new Error("LLM_PROVIDER_NOT_CONFIGURED: test extractor failure");
    };

    const result = await executor.execute("import_experience_candidates_from_text", {
      text: "I published a first-author paper about multimodal emotion recognition.",
    }, context);

    expect(result.status).toBe("needs_input");
    expect(result.message).not.toMatch(/Tool execution failed/i);
    expect(result.visibility).toBe("error_user_visible");
    expect(result.actionResult).toMatchObject({
      status: "needs_input",
      actionType: "import_experience_candidates_from_text",
      reason: "candidate_extraction_unavailable",
    });
    expect((result.actionResult as Record<string, unknown>).jobId).toMatch(/^pimp-/);
    kernel.productServices.importService.createCandidatesFromText = original;
    await kernel.close();
  });

  it("imports publication-style experience candidates without treating online details as required", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const result = await executor.execute("import_experience_candidates_from_text", {
      text: "帮我添加经历，我以第一作者的身份在顶级期刊Transaction on Multimedia上发表了论文Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition，是一个多模态情感识别相关的论文，你可以上网去了解一些细节",
    }, context);
    process.env.NODE_ENV = originalNodeEnv;

    expect(result.status).toBe("success");
    expect(result.message).not.toMatch(/Tool execution failed/i);
    const data = result.data as { candidates: Array<{ title: string; category: string; organization?: string; role?: string; content?: string; structured?: Record<string, unknown> }> };
    expect(data.candidates.length).toBeGreaterThan(0);
    const candidate = data.candidates[0]!;
    const semanticFields = JSON.stringify({
      title: candidate.title,
      organization: candidate.organization,
      role: candidate.role,
      content: candidate.content,
      structured: candidate.structured,
    }).toLowerCase();
    expect(candidate.category).toBe("project");
    expect(candidate.title).toBe("第一作者发表多模态情感识别论文");
    expect(candidate.role).toBe("第一作者");
    expect(candidate.organization).toBe("IEEE Transactions on Multimedia");
    expect(candidate.content).toContain("以第一作者身份发表论文");
    expect(candidate.content).toContain("Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition");
    expect(candidate.content).toContain("多模态情感识别");
    expect(candidate.structured?.inputLanguage).toBe("zh");
    expect(candidate.structured?.projectName).toBe("Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition");
    expect(semanticFields).toContain("external details are unverified");
    expect(semanticFields).not.toMatch(/doi|impact factor|\bcitations?\b|author list|\b(?:2024|2025|2026)\b/);
    await kernel.close();
  });

  it("keeps English publication-style import candidates in English", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const result = await executor.execute("import_experience_candidates_from_text", {
      text: "Please add my experience. I published a paper as the first author in Transactions on Multimedia, titled Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition, which is related to multimodal emotion recognition. You can go online to learn more.",
    }, context);
    process.env.NODE_ENV = originalNodeEnv;

    expect(result.status).toBe("success");
    const data = result.data as { candidates: Array<{ title: string; category: string; organization?: string; role?: string; content?: string; structured?: Record<string, unknown> }> };
    const candidate = data.candidates[0]!;
    expect(candidate.category).toBe("project");
    expect(candidate.title).toBe("Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition");
    expect(candidate.role).toBe("first author");
    expect(candidate.organization).toBe("IEEE Transactions on Multimedia");
    expect(candidate.content).toContain("Published");
    expect(candidate.content).toContain("multimodal emotion recognition");
    expect(candidate.structured?.inputLanguage).toBe("en");
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

    expect(result.status).toBe("success");
    const data = result.data as { experienceId: string };
    expect(data.experienceId).toBeDefined();

    // Verify saved experience in DB
    const exp = await kernel.productServices.experienceService.getExperience("user-1", data.experienceId);
    expect(exp).not.toBeNull();
    expect(exp!.title).toBeDefined();
    await kernel.close();
  });
});
