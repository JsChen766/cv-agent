import { describe, expect, it } from "vitest";
import { createExperienceAgentTools } from "../src/agent-tools/experience/index.js";
import { createResumeAgentTools } from "../src/agent-tools/resume/index.js";
import { createEvidenceAgentTools } from "../src/agent-tools/evidence/index.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

describe("LLM-first closed loops", () => {
  // Loop 1: Experience CRUD
  it("loop 1: experience CRUD (create -> list -> detail -> revision -> variant)", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    // Create experience via save_experience_from_text
    const saved = await executor.execute("save_experience_from_text", {
      text: "2024.01 - 2025.06\nAcme Corp\nSenior Software Engineer\nBuilt microservices with Node.js and PostgreSQL, reduced latency by 40%.",
    }, context);
    expect(saved.status).toBe("success");
    const expId = (saved.data as { experienceId: string }).experienceId;
    expect(expId).toMatch(/^pexp-/);

    // List
    const listed = await executor.execute("list_experiences", {}, context);
    expect((listed.data as { count: number }).count).toBeGreaterThanOrEqual(1);

    // Detail
    const detail = await executor.execute("get_experience", { id: expId }, context);
    expect(detail.status).toBe("success");

    // Create revision
    const updateResult = await executor.execute("update_experience", {
      experienceId: expId,
      content: "Updated content with new metrics: reduced latency by 50%.",
    }, context);
    expect(updateResult.status).toBe("success");
    const metadata = (updateResult.actionResult as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.revisionId).toBeTruthy();

    // Create variant
    const revisions = await kernel.productServices.experienceService.listRevisions("user-1", expId);
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const variant = await kernel.productServices.experienceService.createVariant(
      "user-1", expId, revisions[0].id,
      { variantType: "short", language: "en", content: "Short version of experience." },
    );
    expect(variant.id).toMatch(/^pexpvar-/);

    await kernel.close();
  });

  // Loop 2: Text import -> LLM candidates -> accept -> experience
  it("loop 2: text import -> candidates -> accept -> experience", async () => {
    const kernel = await createP12Kernel();

    // Create import job
    const job = await kernel.productServices.importService.createTextImportJob("user-1",
      "2023.06 - 2024.12\nGoogle\nSoftware Engineer Intern\nWorked on search indexing pipeline. Reduced indexing latency by 30%.\n\n" +
      "University of California, Berkeley\nB.S. Computer Science, GPA 3.9\nCourses: Algorithms, ML, Distributed Systems",
    );
    expect(job.id).toMatch(/^pimp-/);

    // Generate candidates (uses LLM extraction when available, rule-based fallback otherwise)
    const candidates = await kernel.productServices.importService.createCandidatesFromText("user-1", job.id);
    expect(candidates.length).toBeGreaterThan(0);

    // Verify candidate structure
    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^pimpcand-/);
      expect(candidate.title).toBeDefined();
      expect(candidate.category).toBeDefined();
      expect(candidate.content).toBeDefined();
      expect(candidate.status).toBe("pending");
    }

    // Accept a candidate
    const accepted = await kernel.productServices.importService.acceptCandidate("user-1", candidates[0].id);
    expect(accepted.experience.id).toMatch(/^pexp-/);
    expect(accepted.candidate.status).toBe("accepted");

    // Verify experience is in the library
    const exp = await kernel.productServices.experienceService.getExperience("user-1", accepted.experience.id);
    expect(exp).not.toBeNull();
    expect(exp!.title).toBeDefined();

    await kernel.close();
  });

  // Loop 3: JD -> LLM variants -> accept variant -> resume item
  it("loop 3: JD -> generation -> variants -> accept -> resume item", async () => {
    const kernel = await createP12Kernel();

    // First create some experiences
    await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Backend Developer",
      category: "work",
      content: "Developed REST APIs with Node.js and PostgreSQL. Improved API response time by 30%.",
      organization: "TechCorp",
      role: "Backend Developer",
      startDate: "2022-01",
      endDate: "2024-06",
      source: "manual",
    });

    // Generate from JD
    const result = await kernel.productServices.generationProductService.generateResumeFromJD({
      userId: "user-1",
      jdText: "We are looking for a Senior Backend Engineer with experience in Node.js, PostgreSQL, and API design.",
      targetRole: "Senior Backend Engineer",
    });

    expect(result.generation.id).toMatch(/^pgen-/);
    expect(result.variants.length).toBeGreaterThan(0);

    // Verify variant structure
    for (const variant of result.variants) {
      expect(variant.id).toMatch(/^pvar-/);
      expect(variant.content).toBeTruthy();
      expect(variant.scores).toBeDefined();
    }
    // Without LLM (test kernel), the template fallback is used, which contains Chinese text.
    // With LLM, the content would be actual resume content in the target language.
    expect(result.variants[0].content).toBeTruthy();
    expect(result.variants[0].scores).toBeDefined();

    // Accept a variant into a resume
    const saved = await kernel.productServices.generationProductService.saveAcceptedVariantToResume("user-1", {
      generationId: result.generation.id,
      variantId: result.variants[0].id,
    });
    expect(saved.item.id).toMatch(/^presitem-/);
    expect(saved.resume.id).toMatch(/^pres-/);
    expect(saved.item.contentSnapshot).toBeTruthy();

    await kernel.close();
  });

  // Loop 4: Copilot action -> pending action -> confirm -> data change
  it("loop 4: action -> pending -> confirm -> data change", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany([...createExperienceAgentTools(), ...createResumeAgentTools(), ...createEvidenceAgentTools()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    // Step 1: Execute a write action (save_experience_from_text) which requires confirmation
    const actionResult = await executor.execute("save_experience_from_text", {
      text: "2025.01 - present\nStartupAI\nML Engineer\nBuilt recommendation models with PyTorch.",
    }, context);

    // Since this is a write tool with requiresConfirmation=true, the executor handles it.
    // In the real copilot flow, a pending action is created. Here we verify the tool works.
    expect(actionResult.status).toBe("success");
    const expId = (actionResult.data as { experienceId: string }).experienceId;
    expect(expId).toMatch(/^pexp-/);

    // Step 2: Prepare an update to preview changes
    const prepared = await executor.execute("prepare_update_experience", {
      experienceId: expId,
      content: "Improved: Built state-of-the-art recommendation models achieving 25% improvement in click-through rate.",
    }, context);
    expect(prepared.status).toBe("success");

    // Step 3: Confirm the update (in real flow, this goes through pending action)
    const updated = await executor.execute("update_experience", {
      experienceId: expId,
      content: "Improved: Built state-of-the-art recommendation models achieving 25% improvement in click-through rate.",
    }, context);
    expect(updated.status).toBe("success");

    // Step 4: Verify data changed in DB
    const exp = await kernel.productServices.experienceService.getExperience("user-1", expId);
    expect(exp).not.toBeNull();
    const revisions = await kernel.productServices.experienceService.listRevisions("user-1", expId);
    expect(revisions.length).toBeGreaterThanOrEqual(2); // original + update

    // Step 5: Verify the revisionSuggestion is present in update result
    const suggestion = (updated.actionResult as Record<string, unknown> | undefined)?.revisionSuggestion as Record<string, unknown> | undefined;
    expect(suggestion).toBeDefined();
    expect(suggestion?.kind).toBe("experience");
    expect(suggestion?.sourceId).toBe(expId);
    expect(suggestion?.rewrittenText).toBeTruthy();

    await kernel.close();
  });
});
