import { describe, expect, it, vi } from "vitest";
import type { ApiKernel } from "../src/api/types.js";
import { ActiveAssetContextBuilder } from "../src/copilot/ActiveAssetContextBuilder.js";
import type { CopilotWorkspace, ProductVariant } from "../src/copilot/types.js";
import type {
  ProductExperience,
  ProductExperienceRevision,
  ProductJDRecord,
  ProductResumeDetail,
  ProductResumeItem,
} from "../src/product/types.js";

describe("ActiveAssetContextBuilder", () => {
  it("returns activeJD preview when activeJDId is present", async () => {
    const jd = jdRecord({ id: "jd-1", rawText: "React ".repeat(300) });
    const builder = new ActiveAssetContextBuilder(mockKernel({
      jdService: { getJD: vi.fn().mockResolvedValue(jd) },
    }));

    const context = await builder.build({
      userId: "user-1",
      request: { message: "Generate from this JD", clientState: { activeJDId: "jd-1" } },
      workspace: null,
    });

    expect(context.activeJD).toMatchObject({
      id: "jd-1",
      title: "Senior Frontend JD",
      company: "Acme",
      targetRole: "Senior Frontend Engineer",
      rawTextLength: jd.rawText.length,
    });
    expect(context.activeJD?.rawTextPreview).toBe(jd.rawText.slice(0, 1_200));
  });

  it("returns selected resume item preview when activeResumeId and activeResumeItemId are present", async () => {
    const selectedItem = resumeItem({
      id: "item-1",
      resumeId: "resume-1",
      contentSnapshot: "Built React systems. ".repeat(80),
    });
    const resume = resumeDetail({ id: "resume-1", items: [selectedItem] });
    const builder = new ActiveAssetContextBuilder(mockKernel({
      resumeService: { getResume: vi.fn().mockResolvedValue(resume) },
    }));

    const context = await builder.build({
      userId: "user-1",
      request: {
        message: "Optimize this resume item",
        clientState: { activeResumeId: "resume-1", activeResumeItemId: "item-1" },
      },
      workspace: null,
    });

    expect(context.activeResume).toMatchObject({
      id: "resume-1",
      title: "Frontend draft",
      itemCount: 1,
      selectedItem: {
        id: "item-1",
        title: "Acme project",
        sectionType: "experience",
        contentLength: selectedItem.contentSnapshot.length,
      },
    });
    expect(context.activeResume?.selectedItem?.contentPreview).toBe(selectedItem.contentSnapshot.slice(0, 800));
  });

  it("returns current revision preview when activeExperienceId and currentRevisionId are present", async () => {
    const experience = productExperience({ id: "exp-1", currentRevisionId: "rev-current" });
    const revisions = [
      experienceRevision({ id: "rev-newer", experienceId: "exp-1", content: "Newer content", createdAt: "2026-01-03T00:00:00.000Z" }),
      experienceRevision({ id: "rev-current", experienceId: "exp-1", content: "Current revision content", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const builder = new ActiveAssetContextBuilder(mockKernel({
      experienceService: {
        getExperience: vi.fn().mockResolvedValue(experience),
        listRevisions: vi.fn().mockResolvedValue(revisions),
      },
    }));

    const context = await builder.build({
      userId: "user-1",
      request: { message: "Rewrite this experience", clientState: { activeExperienceId: "exp-1" } },
      workspace: null,
    });

    expect(context.activeExperience).toMatchObject({
      id: "exp-1",
      title: "Search rewrite",
      category: "project",
      organization: "Acme",
      role: "Frontend Engineer",
      contentPreview: "Current revision content",
      contentLength: "Current revision content".length,
    });
  });

  it("uses newest createdAt revision when activeExperienceId has no currentRevisionId", async () => {
    const experience = productExperience({ id: "exp-1", currentRevisionId: undefined });
    const revisions = [
      experienceRevision({ id: "rev-middle", experienceId: "exp-1", content: "Middle content", createdAt: "2026-01-02T00:00:00.000Z" }),
      experienceRevision({ id: "rev-oldest", experienceId: "exp-1", content: "Oldest content", createdAt: "2026-01-01T00:00:00.000Z" }),
      experienceRevision({ id: "rev-newest", experienceId: "exp-1", content: "Newest content", createdAt: "2026-01-03T00:00:00.000Z" }),
    ];
    const builder = new ActiveAssetContextBuilder(mockKernel({
      experienceService: {
        getExperience: vi.fn().mockResolvedValue(experience),
        listRevisions: vi.fn().mockResolvedValue(revisions),
      },
    }));

    const context = await builder.build({
      userId: "user-1",
      request: { message: "Rewrite this experience", clientState: { activeExperienceId: "exp-1" } },
      workspace: null,
    });

    expect(context.activeExperience?.contentPreview).toBe("Newest content");
  });

  it("returns activeVariant preview from workspace variants when activeVariantId is present", async () => {
    const context = await new ActiveAssetContextBuilder(mockKernel()).build({
      userId: "user-1",
      request: { message: "Explain", clientState: { activeVariantId: "variant-1" } },
      workspace: workspaceWithVariants([variant({ id: "variant-1" })]),
    });

    expect(context.activeVariant).toMatchObject({
      id: "variant-1",
      title: "React platform rewrite",
      role: "recommended",
      status: "ready",
    });
    expect(context.activeVariant?.contentPreview).toBe("Built React platform capabilities. ".repeat(80).slice(0, 800));
  });

  it("does not throw when active assets cannot be found", async () => {
    const builder = new ActiveAssetContextBuilder(mockKernel({
      jdService: { getJD: vi.fn().mockResolvedValue(null) },
      resumeService: { getResume: vi.fn().mockResolvedValue(undefined) },
      experienceService: {
        getExperience: vi.fn().mockRejectedValue(new Error("not found")),
        listRevisions: vi.fn(),
      },
    }));

    await expect(builder.build({
      userId: "user-1",
      request: {
        message: "What is active?",
        clientState: {
          activeJDId: "missing-jd",
          activeResumeId: "missing-resume",
          activeExperienceId: "missing-experience",
          activeVariantId: "missing-variant",
        },
      },
      workspace: workspaceWithVariants([]),
    })).resolves.toEqual({});
  });
});

function mockKernel(overrides: {
  jdService?: Partial<ApiKernel["productServices"]["jdService"]>;
  resumeService?: Partial<ApiKernel["productServices"]["resumeService"]>;
  experienceService?: Partial<ApiKernel["productServices"]["experienceService"]>;
} = {}): Pick<ApiKernel, "productServices"> {
  return {
    productServices: {
      jdService: {
        getJD: vi.fn().mockResolvedValue(null),
        ...overrides.jdService,
      },
      resumeService: {
        getResume: vi.fn().mockResolvedValue(null),
        ...overrides.resumeService,
      },
      experienceService: {
        getExperience: vi.fn().mockResolvedValue(null),
        listRevisions: vi.fn().mockResolvedValue([]),
        ...overrides.experienceService,
      },
    },
  } as unknown as Pick<ApiKernel, "productServices">;
}

function jdRecord(overrides: Partial<ProductJDRecord> = {}): ProductJDRecord {
  return {
    id: "jd-1",
    userId: "user-1",
    title: "Senior Frontend JD",
    company: "Acme",
    targetRole: "Senior Frontend Engineer",
    rawText: "React frontend role",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function resumeDetail(overrides: Partial<ProductResumeDetail> = {}): ProductResumeDetail {
  return {
    id: "resume-1",
    userId: "user-1",
    title: "Frontend draft",
    targetRole: "Frontend Engineer",
    status: "draft",
    templateId: "template-default",
    items: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function resumeItem(overrides: Partial<ProductResumeItem> = {}): ProductResumeItem {
  return {
    id: "item-1",
    resumeId: "resume-1",
    userId: "user-1",
    title: "Acme project",
    sectionType: "experience",
    contentSnapshot: "Built React systems.",
    orderIndex: 0,
    hidden: false,
    pinned: false,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function productExperience(overrides: Partial<ProductExperience> = {}): ProductExperience {
  return {
    id: "exp-1",
    userId: "user-1",
    category: "project",
    title: "Search rewrite",
    organization: "Acme",
    role: "Frontend Engineer",
    tags: [],
    status: "active",
    currentRevisionId: "rev-current",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function experienceRevision(overrides: Partial<ProductExperienceRevision> = {}): ProductExperienceRevision {
  return {
    id: "rev-1",
    experienceId: "exp-1",
    userId: "user-1",
    content: "Revision content",
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function workspaceWithVariants(variants: ProductVariant[]): CopilotWorkspace {
  return {
    id: "ws-1",
    sessionId: "session-1",
    activeVariantId: "variant-1",
    status: "ready",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants,
  };
}

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
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
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
