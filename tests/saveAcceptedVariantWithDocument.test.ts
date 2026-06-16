import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ExperienceService,
  GenerationProductService,
  JDService,
  ResumeService,
} from "../src/product/services/index.js";
import {
  InMemoryProductExperienceRepository,
  InMemoryProductGenerationRepository,
  InMemoryProductJDRepository,
  InMemoryProductResumeRepository,
} from "../src/product/repositories/index.js";
import type {
  ProductGeneratedVariant,
  ProductGeneration,
  ResumeDocument,
} from "../src/product/types.js";

function bootService() {
  const experienceRepo = new InMemoryProductExperienceRepository();
  const jdRepo = new InMemoryProductJDRepository();
  const resumeRepo = new InMemoryProductResumeRepository();
  const generationRepo = new InMemoryProductGenerationRepository();
  const experienceService = new ExperienceService(experienceRepo);
  const jdService = new JDService(jdRepo);
  const resumeService = new ResumeService(resumeRepo);
  const generationService = new GenerationProductService(
    generationRepo,
    jdService,
    resumeService,
    experienceService,
  );
  return { generationService, generationRepo, resumeService };
}

function makeVariant(content: string, resumeDocument?: ResumeDocument): ProductGeneratedVariant {
  return {
    id: `pvar-${randomUUID()}`,
    userId: "user-1",
    content,
    sourceExperienceIds: [],
    sourceEvidenceIds: [],
    scores: { overall: 0.8, relevance: 0.8, evidenceStrength: 0.8 },
    createdAt: new Date().toISOString(),
    reason: "test",
    resumeDocument,
  };
}

async function seedGeneration(
  repo: InMemoryProductGenerationRepository,
  variants: ProductGeneratedVariant[],
): Promise<ProductGeneration> {
  const generation: ProductGeneration = {
    id: `pgen-${randomUUID()}`,
    userId: "user-1",
    sessionId: undefined,
    jdId: undefined,
    targetRole: "Frontend Engineer",
    inputSnapshot: { sourceExperienceIds: [] },
    outputSnapshot: { variants },
    selectedVariantIds: [],
    createdAt: new Date().toISOString(),
  };
  return repo.createGeneration(generation);
}

const VALID_DOCUMENT: ResumeDocument = {
  schemaVersion: 1,
  sections: [
    {
      id: "sec-exp",
      type: "experience",
      title: "工作经历",
      order: 0,
      items: [
        {
          id: "item-1",
          title: "高级前端工程师",
          subtitle: "字节跳动",
          period: "2022-2024",
          bullets: [
            { id: "b-1", text: "主导组件库重构", evidenceIds: ["exp-1"] },
            { id: "b-2", text: "推动 SSR 上线" },
          ],
          sourceExperienceId: "exp-1",
          evidenceStrength: "high",
          relevanceScore: 0.9,
        },
        {
          id: "item-2",
          title: "前端工程师",
          subtitle: "美团",
          period: "2020-2022",
          bullets: [{ id: "b-3", text: "负责支付页性能优化" }],
        },
      ],
    },
    {
      id: "sec-edu",
      type: "education",
      title: "教育背景",
      order: 1,
      items: [
        {
          id: "item-edu",
          title: "计算机科学硕士",
          subtitle: "清华大学",
          period: "2017-2020",
          bullets: [{ id: "b-edu", text: "GPA 3.9 / 4.0" }],
        },
      ],
    },
  ],
};

describe("saveAcceptedVariantToResume — structured ResumeDocument path", () => {
  it("falls back to single-item legacy path when variant has no resumeDocument (byte-identical to Phase 2)", async () => {
    const { generationService, generationRepo } = bootService();
    const variant = makeVariant("Single legacy variant content.\nLine 2.");
    const generation = await seedGeneration(generationRepo, [variant]);

    const accepted = await generationService.saveAcceptedVariantToResume("user-1", {
      generationId: generation.id,
      variantId: variant.id,
    });

    // Legacy contract: a single ProductResumeItem; `items` array NOT populated.
    expect(accepted.item).toBeDefined();
    expect(accepted.item.contentSnapshot).toBe("Single legacy variant content.\nLine 2.");
    expect(accepted.item.sectionType).toBe("experience");
    expect(accepted.items).toBeUndefined();
    expect(accepted.variant.id).toBe(variant.id);
  });

  it("fans out into one ProductResumeItem per document item when resumeDocument is structurally valid", async () => {
    const { generationService, generationRepo, resumeService } = bootService();
    const variant = makeVariant("Display content (unused in structured path).", VALID_DOCUMENT);
    const generation = await seedGeneration(generationRepo, [variant]);

    const accepted = await generationService.saveAcceptedVariantToResume("user-1", {
      generationId: generation.id,
      variantId: variant.id,
    });

    expect(accepted.items).toBeDefined();
    expect(accepted.items!.length).toBe(3); // 2 experience + 1 education
    // `item` always points at the first item for backward compatibility.
    expect(accepted.item).toBe(accepted.items![0]);

    // Section types map through.
    const sectionTypes = accepted.items!.map((i) => i.sectionType);
    expect(sectionTypes).toEqual(["experience", "experience", "education"]);

    // Titles map from document items.
    expect(accepted.items![0].title).toBe("高级前端工程师");
    expect(accepted.items![2].title).toBe("计算机科学硕士");

    // sourceExperienceId on item 1 propagates from resumeDocument.
    expect(accepted.items![0].sourceExperienceId).toBe("exp-1");

    // contentSnapshot includes header (title · subtitle · period) and bullet lines.
    expect(accepted.items![0].contentSnapshot).toContain("高级前端工程师");
    expect(accepted.items![0].contentSnapshot).toContain("字节跳动");
    expect(accepted.items![0].contentSnapshot).toContain("- 主导组件库重构");
    expect(accepted.items![0].contentSnapshot).toContain("- 推动 SSR 上线");

    // metadata persists structural ids needed by future stages.
    expect(accepted.items![0].metadata).toMatchObject({
      generationId: generation.id,
      sourceVariantId: variant.id,
      sectionId: "sec-exp",
      sectionType: "experience",
      sectionOrder: 0,
      itemId: "item-1",
      bulletIds: ["b-1", "b-2"],
      sourceExperienceId: "exp-1",
      evidenceStrength: "high",
      relevanceScore: 0.9,
    });
    expect(accepted.items![2].metadata).toMatchObject({
      sectionId: "sec-edu",
      sectionType: "education",
      itemId: "item-edu",
      bulletIds: ["b-edu"],
    });

    // Resume actually persisted with all three items.
    const resumeDetail = await resumeService.getResume("user-1", accepted.resume.id);
    expect(resumeDetail!.items.length).toBe(3);

    // Generation now lists the variant as selected.
    expect(accepted.generation.selectedVariantIds).toContain(variant.id);
  });

  it("activates the structured path even for a single-item resumeDocument (≥1 valid item)", async () => {
    const oneItemDoc: ResumeDocument = {
      schemaVersion: 1,
      sections: [
        {
          id: "sec-x",
          type: "project",
          title: "项目",
          order: 0,
          items: [
            {
              id: "item-x",
              title: "支付重构",
              bullets: [{ id: "b-x", text: "主导后端重写" }],
            },
          ],
        },
      ],
    };
    const { generationService, generationRepo } = bootService();
    const variant = makeVariant("Anything.", oneItemDoc);
    const generation = await seedGeneration(generationRepo, [variant]);

    const accepted = await generationService.saveAcceptedVariantToResume("user-1", {
      generationId: generation.id,
      variantId: variant.id,
    });

    expect(accepted.items).toHaveLength(1);
    expect(accepted.item.sectionType).toBe("project");
    expect(accepted.item.metadata).toMatchObject({ sectionId: "sec-x", itemId: "item-x" });
  });

  it("appends to an existing resume (resumeId provided) and continues orderIndex sequence", async () => {
    const { generationService, generationRepo, resumeService } = bootService();
    const existingResume = await resumeService.createResume("user-1", { title: "Existing" });
    await resumeService.addResumeItem("user-1", existingResume.id, {
      title: "Pre-existing item",
      contentSnapshot: "Pre-existing content.",
      sectionType: "summary",
    });
    const variant = makeVariant("ignored", VALID_DOCUMENT);
    const generation = await seedGeneration(generationRepo, [variant]);

    const accepted = await generationService.saveAcceptedVariantToResume("user-1", {
      generationId: generation.id,
      variantId: variant.id,
      resumeId: existingResume.id,
    });

    expect(accepted.resume.id).toBe(existingResume.id);
    const detail = await resumeService.getResume("user-1", existingResume.id);
    expect(detail!.items.length).toBe(1 + 3); // 1 pre-existing + 3 from document
  });
});
