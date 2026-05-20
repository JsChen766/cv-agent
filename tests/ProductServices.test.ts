import { beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";

function setupEnv() {
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

describe("Product services", () => {
  let kernel: ApiKernel;

  beforeEach(async () => {
    setupEnv();
    kernel = await createKernel();
  });

  it("creates, lists, and gets product experiences with an initial revision", async () => {
    const { experience, revision } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "React performance",
      category: "project",
      content: "Reduced bundle size by 40% with React and TypeScript.",
    });

    expect(experience.currentRevisionId).toBe(revision.id);
    expect((await kernel.productServices.experienceService.listExperiences("user-1"))[0]?.id).toBe(experience.id);
    expect(await kernel.productServices.experienceService.getExperience("user-1", experience.id)).toMatchObject({ id: experience.id });
  });

  it("creates revisions without overwriting previous revisions and creates variants", async () => {
    const { experience, revision } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Design system",
      content: "Built design system.",
    });
    const second = await kernel.productServices.experienceService.createRevision("user-1", experience.id, {
      content: "Built design system and improved delivery speed.",
    });
    const revisions = await kernel.productServices.experienceService.listRevisions("user-1", experience.id);
    const variant = await kernel.productServices.experienceService.createVariant("user-1", experience.id, second.id, {
      content: "Improved delivery speed with a reusable design system.",
      variantType: "short",
    });

    expect(revisions.map((item) => item.id)).toEqual(expect.arrayContaining([revision.id, second.id]));
    expect(variant.revisionId).toBe(second.id);
  });

  it("saves/lists/gets JD records", async () => {
    const jd = await kernel.productServices.jdService.saveJD("user-1", {
      rawText: "React TypeScript performance role.",
      targetRole: "Frontend Engineer",
    });
    expect((await kernel.productServices.jdService.listJDs("user-1"))[0]?.id).toBe(jd.id);
    expect(await kernel.productServices.jdService.getJD("user-1", jd.id)).toMatchObject({ id: jd.id });
  });

  it("creates/list/gets resumes and stores item snapshots", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { targetRole: "FE" });
    const item = await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "React performance",
      contentSnapshot: "Reduced bundle size by 40%.",
    });
    const detail = await kernel.productServices.resumeService.getResume("user-1", resume.id);

    expect((await kernel.productServices.resumeService.listResumes("user-1"))[0]?.id).toBe(resume.id);
    expect(detail?.items[0]?.contentSnapshot).toBe(item.contentSnapshot);
  });

  it("creates text import jobs and accepting a candidate creates an experience", async () => {
    const job = await kernel.productServices.importService.createTextImportJob("user-1", "Built React systems.\n\nReduced bundle size.");
    const candidates = await kernel.productServices.importService.createCandidatesFromText("user-1", job.id);
    const accepted = await kernel.productServices.importService.acceptCandidate("user-1", candidates[0]!.id);

    expect(candidates.length).toBeGreaterThan(0);
    expect(accepted.experience.title.length).toBeGreaterThan(0);
  });

  it("generateResumeFromJD creates a product_generation", async () => {
    const result = await kernel.productServices.generationProductService.generateResumeFromJD({
      userId: "user-1",
      jdText: "React TypeScript performance optimization role.",
      targetRole: "Frontend Engineer",
    });

    expect(result.variants.length).toBeGreaterThan(0);
    expect(await kernel.productServices.generationProductService.getGeneration("user-1", result.generation.id)).toMatchObject({ id: result.generation.id });
  });
});
