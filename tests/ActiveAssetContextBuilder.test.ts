import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import { ActiveAssetContextBuilder } from "../src/copilot/ActiveAssetContextBuilder.js";

describe("ActiveAssetContextBuilder", () => {
  let kernel: ApiKernel;
  let builder: ActiveAssetContextBuilder;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "fake";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    builder = new ActiveAssetContextBuilder(kernel);
  });

  afterEach(async () => {
    await kernel.close();
  });

  it("returns activeJD preview when activeJDId is present", async () => {
    const jd = await kernel.productServices.jdService.saveJD("user-1", {
      title: "Senior Frontend JD",
      company: "Acme",
      targetRole: "Senior Frontend Engineer",
      rawText: "React ".repeat(300),
    });

    const context = await builder.build({
      userId: "user-1",
      request: { message: "根据这个 JD 生成简历", clientState: { activeJDId: jd.id } },
      workspace: null,
    });

    expect(context.activeJD).toMatchObject({
      id: jd.id,
      title: "Senior Frontend JD",
      company: "Acme",
      targetRole: "Senior Frontend Engineer",
      rawTextLength: "React ".repeat(300).length,
    });
    expect(context.activeJD?.rawTextPreview?.length).toBeLessThanOrEqual(1_200);
  });

  it("returns selected resume item preview when activeResumeId and activeResumeItemId are present", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", {
      title: "Frontend draft",
      targetRole: "Frontend Engineer",
    });
    const item = await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Acme project",
      sectionType: "experience",
      contentSnapshot: "Built React systems. ".repeat(80),
    });

    const context = await builder.build({
      userId: "user-1",
      request: {
        message: "这段再量化一点",
        clientState: { activeResumeId: resume.id, activeResumeItemId: item.id },
      },
      workspace: null,
    });

    expect(context.activeResume).toMatchObject({
      id: resume.id,
      title: "Frontend draft",
      itemCount: 1,
      selectedItem: {
        id: item.id,
        title: "Acme project",
        sectionType: "experience",
        contentLength: "Built React systems. ".repeat(80).length,
      },
    });
    expect(context.activeResume?.selectedItem?.contentPreview?.length).toBeLessThanOrEqual(800);
  });

  it("returns latest experience revision preview when activeExperienceId is present", async () => {
    const created = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Search rewrite",
      category: "project",
      content: "Initial content",
      organization: "Acme",
      role: "Frontend Engineer",
    });
    await kernel.productServices.experienceService.createRevision("user-1", created.experience.id, {
      content: "Latest rewrite content. ".repeat(70),
      source: "copilot",
    });

    const context = await builder.build({
      userId: "user-1",
      request: { message: "重写这个经历", clientState: { activeExperienceId: created.experience.id } },
      workspace: null,
    });

    expect(context.activeExperience).toMatchObject({
      id: created.experience.id,
      title: "Search rewrite",
      category: "project",
      organization: "Acme",
      role: "Frontend Engineer",
      contentLength: "Latest rewrite content. ".repeat(70).length,
    });
    expect(context.activeExperience?.contentPreview).toContain("Latest rewrite content.");
    expect(context.activeExperience?.contentPreview?.length).toBeLessThanOrEqual(800);
  });

  it("prefers currentRevisionId over a newer experience revision", async () => {
    const created = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Current revision wins",
      category: "project",
      content: "Current revision content",
    });
    await kernel.productServices.experienceService.createRevision("user-1", created.experience.id, {
      content: "Newer non-current content",
      source: "copilot",
    });
    await kernel.productServices.experienceService.updateExperience("user-1", created.experience.id, {
      currentRevisionId: created.revision.id,
    });

    const context = await builder.build({
      userId: "user-1",
      request: { message: "rewrite", clientState: { activeExperienceId: created.experience.id } },
      workspace: null,
    });

    expect(context.activeExperience?.contentPreview).toBe("Current revision content");
  });

  it("falls back to newest createdAt revision when currentRevisionId is missing", async () => {
    const created = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Latest fallback",
      category: "project",
      content: "Older revision content",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await kernel.productServices.experienceService.createRevision("user-1", created.experience.id, {
      content: "Newest fallback content",
      source: "copilot",
    });
    await kernel.productServices.experienceService.updateExperience("user-1", created.experience.id, {
      currentRevisionId: undefined,
    });

    const context = await builder.build({
      userId: "user-1",
      request: { message: "rewrite", clientState: { activeExperienceId: created.experience.id } },
      workspace: null,
    });

    expect(context.activeExperience?.contentPreview).toBe("Newest fallback content");
  });

  it("does not throw and returns an empty context when assets are missing", async () => {
    await expect(builder.build({
      userId: "user-1",
      request: {
        message: "这个是什么？",
        clientState: {
          activeJDId: "missing-jd",
          activeResumeId: "missing-resume",
          activeExperienceId: "missing-experience",
          activeVariantId: "missing-variant",
        },
      },
      workspace: null,
    })).resolves.toEqual({});
  });

  it("returns activeVariant preview from workspace variants when activeVariantId is present", async () => {
    const context = await builder.build({
      userId: "user-1",
      request: { message: "explain", clientState: { activeVariantId: "variant-1" } },
      workspace: {
        id: "ws-1",
        sessionId: "session-1",
        activeVariantId: "variant-1",
        status: "ready",
        updatedAt: new Date().toISOString(),
        variants: [{
          id: "variant-1",
          artifactId: "artifact-1",
          title: "React platform rewrite",
          content: "Built React platform capabilities. ".repeat(80),
          role: "recommended",
          status: "ready",
          score: {},
          badges: [],
          reason: "Best match.",
          evidenceSummary: { coverageLabel: "No direct evidence linked", items: [] },
          riskSummary: { level: "low", unsupportedClaims: [], missingEvidence: [], warnings: [] },
          missingInfo: [],
          sourceExperienceIds: [],
          sourceEvidenceIds: [],
          actions: [],
          raw: {},
          createdAt: new Date().toISOString(),
        }],
      },
    });

    expect(context.activeVariant).toMatchObject({
      id: "variant-1",
      title: "React platform rewrite",
      role: "recommended",
      status: "ready",
    });
    expect(context.activeVariant?.contentPreview?.length).toBeLessThanOrEqual(800);
  });
});
