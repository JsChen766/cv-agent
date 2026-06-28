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
  ProductExperienceSummary,
  ProductGeneration,
  ResumeDocument,
} from "../src/product/types.js";
import type { LLMExperienceBulletGenerationInput, LLMGeneratedVariantsResult, LLMGenerationService } from "../src/product/LLMGenerationService.js";

function bootService(llmGenerationService?: Pick<LLMGenerationService, "generateVariants"> & Partial<Pick<LLMGenerationService, "generateCareerBulletsForExperience">>) {
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
    llmGenerationService as LLMGenerationService | undefined,
  );
  return { generationService, generationRepo, resumeService, experienceService };
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
    expect(accepted.resume.title).toBe("Frontend Engineer简历");
    expect(accepted.resume.title).not.toContain("draft");
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
    expect(accepted.resume.title).toBe("Frontend Engineer简历");
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
      bulletTexts: {
        "b-1": "主导组件库重构",
        "b-2": "推动 SSR 上线",
      },
      bulletEvidence: {
        "b-1": "exp-1",
      },
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

  it("densifies sparse recommended resumeDocument with evidence-backed internship/project source cards", async () => {
    const sparseDoc: ResumeDocument = {
      schemaVersion: 1,
      sections: [
        {
          id: "sec-exp",
          type: "experience",
          title: "实习经历",
          order: 1,
          items: [
            {
              id: "item-weex",
              title: "数据分析实习生",
              subtitle: "WEEX",
              period: "2026.01-2026.04",
              sourceExperienceId: "seed-weex",
              bullets: [
                { id: "b-weex-1", text: "搭建50+个BI看板，追踪交易与运营指标", evidenceIds: ["source-card-seed-weex"] },
                { id: "b-weex-2", text: "编写95+个SQL脚本支持数据分析", evidenceIds: ["source-card-seed-weex"] },
              ],
            },
          ],
        },
      ],
    };
    const llm = {
      async generateVariants(): Promise<LLMGeneratedVariantsResult> {
        const variant = makeVariant("Sparse content.", sparseDoc);
        variant.id = "pvar-sparse";
        variant.recommended = true;
        return { variants: [variant], recommendedVariantId: variant.id };
      },
    };
    const { generationService, experienceService } = bootService(llm);
    await experienceService.createExperience("user-1", {
      title: "WEEX 数据分析实习",
      category: "internship",
      organization: "WEEX",
      role: "数据分析实习生",
      content: "搭建并交付50+个Power BI/Datawind交互式看板，追踪活动投放、商户运营及核心业务指标，核心运营报表每周浏览量超过200次。编写95+个复杂SQL脚本，使用窗口函数、多表关联等技术提升用户行为与交易数据分析准确性。",
    });
    for (let i = 1; i <= 8; i += 1) {
      await experienceService.createExperience("user-1", {
        title: `补充项目 ${i}`,
        category: "project",
        organization: "南昌大学",
        role: "项目负责人",
        content: `围绕数据处理项目${i}设计采集、清洗、建模与可视化流程，沉淀可复用分析方法并支持跨团队复盘。使用Python、SQL与指标拆解方法处理真实业务数据，输出项目报告和结构化结论。`,
      });
    }

    const result = await generationService.generateResumeFromJD({
      userId: "user-1",
      jdText: "需要数据分析、SQL、BI、项目复盘能力。",
      targetRole: "数据分析师",
    });

    const variant = result.generation.outputSnapshot?.variants?.[0];
    expect(variant).toBeDefined();
    if (!variant) throw new Error("variant missing");
    const careerBullets = variant.resumeDocument!.sections
      .filter((section) => section.type === "experience" || section.type === "project")
      .flatMap((section) => section.items)
      .flatMap((item) => item.bullets);
    const sourceIds = variant.resumeDocument!.sections.flatMap((section) => section.items.map((item) => item.sourceExperienceId).filter(Boolean));
    expect(careerBullets.length).toBeGreaterThanOrEqual(14);
    expect(careerBullets.every((bullet) => bullet.text.length >= 48)).toBe(true);
    expect(careerBullets.filter((bullet) => /，\s*在[^，。；;、,]+(?:中|下|实习生)$|支持按时段$|处理\d{1,2}$|Jiangxi-$|在基于3D运动轨迹跟踪$|[:：]\s*[^，。；;、,]{0,8}$/u.test(bullet.text))).toEqual([]);
    expect(sourceIds.length).toBeGreaterThan(1);
    expect(variant.sourceExperienceIds?.length).toBeGreaterThan(1);
  });

  it("normalizes project headers and replaces near-duplicate career bullets from source evidence", async () => {
    const projectDoc: ResumeDocument = {
      schemaVersion: 1,
      sections: [
        {
          id: "sec-project",
          type: "project",
          title: "项目经历",
          order: 1,
          items: [
            {
              id: "item-moxibustion",
              title: "项目负责人",
              subtitle: "基于3D运动轨迹追踪的艾灸考评系统",
              period: "2023.05-2024.06",
              bullets: [
                { id: "b-1", text: "设计3D运动轨迹采集与识别流程，结合传感器数据完成艾灸动作评分与偏差分析" },
                { id: "b-2", text: "设计3D运动轨迹采集与识别流程，结合传感器数据完成艾灸动作评分与偏差分析" },
                { id: "b-3", text: "业务策略支持与成果落地，研究助理（项目负责人） 2023.05，艾灸操作依赖专家主观经验且缺乏标准化" },
              ],
            },
          ],
        },
      ],
    };
    const llm = {
      async generateVariants(): Promise<LLMGeneratedVariantsResult> {
        const variant = makeVariant("Project content.", projectDoc);
        variant.id = "pvar-project-quality";
        variant.recommended = true;
        return { variants: [variant], recommendedVariantId: variant.id };
      },
    };
    const { generationService, experienceService } = bootService(llm);
    const project = await experienceService.createExperience("user-1", {
      title: "基于3D运动轨迹追踪的艾灸考评系统",
      category: "project",
      organization: "南昌大学",
      role: "项目负责人",
      startDate: "2023.05",
      endDate: "2024.06",
      content: [
        "设计3D运动轨迹采集与识别流程，结合传感器数据完成艾灸动作评分与偏差分析。",
        "优化动作序列校准与误差分析逻辑，提升评分一致性并支持教师复核。",
        "完成实验方案、数据采集规范和用户测试材料，推动系统进入省级重点创业项目。",
      ].join("\n"),
    });

    const result = await generationService.generateResumeFromJD({
      userId: "user-1",
      jdText: "需要传感器数据分析、项目推进、算法评估和用户测试经验。",
      targetRole: "AI 产品数据分析实习生",
    });

    const variant = result.generation.outputSnapshot?.variants?.[0];
    expect(variant?.resumeDocument).toBeDefined();
    const item = variant!.resumeDocument!.sections
      .find((section) => section.type === "project")!
      .items.find((candidate) => candidate.sourceExperienceId === project.experience.id)!;
    expect(item.title).toBe("基于3D运动轨迹追踪的艾灸考评系统");
    expect(item.subtitle).toContain("项目负责人");
    expect(item.bullets.map((bullet) => bullet.text)).toHaveLength(new Set(item.bullets.map((bullet) => bullet.text)).size);
    expect(item.bullets.some((bullet) => bullet.text.includes("评分一致性"))).toBe(true);
    expect(item.bullets.some((bullet) => bullet.text.includes("业务策略支持与成果落地"))).toBe(false);
  });

  it("regenerates each project item with prior bullets as anti-duplication context and keeps at least three bullets", async () => {
    const projectDoc: ResumeDocument = {
      schemaVersion: 1,
      sections: [
        {
          id: "sec-project",
          type: "project",
          title: "项目经历",
          order: 1,
          items: [
            {
              id: "item-health",
              title: "基于分布式声学传感器阵列的建筑物结构健康状态智能监测系统",
              subtitle: "项目负责人",
              period: "2025.05-2026.05",
              bullets: [
                { id: "h-1", text: "设计基于声学全息成像的微弱信号提取模型（A-Hologram），主导撰写《多点分布式声学时钟同步与相位校准方案》" },
                { id: "h-2", text: "设计基于声学全息成像的微弱信号提取模型（A-Hologram），主导撰写《多点分布式声学时钟同步与相位校准方案》" },
                { id: "h-3", text: "主导撰写《多点分布式声学时钟同步与相位校准方案》、《基于声学特征的建筑结构损伤量化评级白皮书》及核心专利申请书" },
              ],
            },
            {
              id: "item-driving",
              title: "基于便携式非侵入神经信号与眼动追踪的混合智能辅助驾乘系统",
              subtitle: "项目负责人",
              period: "2025.02-2026.04",
              bullets: [
                { id: "d-1", text: "将认知心理学上的“视觉注意区”转化为“软交互防分神控制策略”，疲劳行为判定准确率提升了79%" },
              ],
            },
          ],
        },
      ],
    };
    const bulletCalls: Array<Pick<LLMExperienceBulletGenerationInput, "sectionType" | "acceptedBullets"> & { sourceExperienceId: string }> = [];
    const llm = {
      async generateVariants(): Promise<LLMGeneratedVariantsResult> {
        const variant = makeVariant("Project content.", projectDoc);
        variant.id = "pvar-project-refine";
        variant.recommended = true;
        return { variants: [variant], recommendedVariantId: variant.id };
      },
      async generateCareerBulletsForExperience(input: LLMExperienceBulletGenerationInput): Promise<string[]> {
        bulletCalls.push({
          sourceExperienceId: input.sourceExperience.id,
          sectionType: input.sectionType,
          acceptedBullets: [...input.acceptedBullets],
        });
        if (input.sourceExperience.title.includes("神经信号")) {
          if (input.acceptedBullets.length <= 1) {
            return [
              "融合非侵入式神经信号、眼动追踪与驾驶场景标注数据，构建分神风险识别流程并沉淀可复现实验记录",
            ];
          }
          return [
            "设计车载软交互触发策略与提示反馈机制，围绕疲劳识别、注意力迁移和安全干预完成原型验证",
          ];
        }
        return [
          "重复的A-Hologram声学全息成像模型描述",
          "建立声学传感器阵列的相位同步与损伤量化评估流程，支撑结构健康监测报告和专利材料",
        ];
      },
    };
    const { generationService, experienceService } = bootService(llm);
    const health = await experienceService.createExperience("user-1", {
      title: "基于分布式声学传感器阵列的建筑物结构健康状态智能监测系统",
      category: "project",
      organization: "南昌大学",
      role: "项目负责人",
      content: [
        "设计基于声学全息成像的微弱信号提取模型（A-Hologram），完成多点声学阵列时钟同步与相位校准。",
        "编写建筑结构损伤量化评级白皮书，梳理传感器标定、信号降噪和结构异常识别流程。",
        "推进核心专利申请和系统级技术方案，支撑建筑结构健康监测从采集到评估的完整链路。",
      ].join("\n"),
    });
    const driving = await experienceService.createExperience("user-1", {
      title: "基于便携式非侵入神经信号与眼动追踪的混合智能辅助驾乘系统",
      category: "project",
      organization: "南昌大学",
      role: "项目负责人",
      content: [
        "将认知心理学上的视觉注意区转化为软交互防分神控制策略，疲劳行为判定准确率提升79%。",
        "融合非侵入式神经信号、眼动追踪与驾驶场景标注数据，设计分神风险识别与预警流程。",
        "完成车载交互原型、实验记录和安全干预策略验证，支持辅助驾乘系统的场景化评估。",
      ].join("\n"),
    });

    const result = await generationService.generateResumeFromJD({
      userId: "user-1",
      jdText: "需要传感器融合、信号处理、实验验证和智能系统产品化经验。",
      targetRole: "AI 产品数据分析实习生",
    });

    const projectItems = result.generation.outputSnapshot!.variants![0]!.resumeDocument!.sections
      .find((section) => section.type === "project")!
      .items;
    const healthItem = projectItems.find((item) => item.id === "item-health")!;
    const drivingItem = projectItems.find((item) => item.id === "item-driving")!;
    expect(healthItem.sourceExperienceId).toBe(health.experience.id);
    expect(drivingItem.sourceExperienceId).toBe(driving.experience.id);
    expect(new Set(healthItem.bullets.map((bullet) => bullet.text)).size).toBe(healthItem.bullets.length);
    expect(healthItem.bullets.some((bullet) => bullet.text.includes("损伤量化") || bullet.text.includes("结构健康监测"))).toBe(true);
    expect(drivingItem.bullets.length).toBeGreaterThanOrEqual(3);
    expect(new Set(drivingItem.bullets.map((bullet) => bullet.text)).size).toBe(drivingItem.bullets.length);
    const drivingCalls = bulletCalls.filter((call) => call.sourceExperienceId === driving.experience.id);
    expect(drivingCalls.length).toBeGreaterThanOrEqual(1);
    expect(drivingCalls[0]!.acceptedBullets.length).toBeGreaterThanOrEqual(1);
  });

  it("shortlists baseline sections plus top 3 work-like and top 3 project experiences before calling the LLM", async () => {
    let captured: Array<Pick<ProductExperienceSummary, "id" | "category" | "title">> = [];
    const llm = {
      async generateVariants(
        _userId: string,
        _jdText: string,
        _targetRole: string | undefined,
        experiences: ProductExperienceSummary[],
      ): Promise<LLMGeneratedVariantsResult> {
        captured = experiences.map((item) => ({
          id: item.id,
          category: item.category,
          title: item.title,
        }));
        const variant = makeVariant("Shortlisted content.");
        return { variants: [variant], recommendedVariantId: variant.id };
      },
    };
    const { generationService, experienceService } = bootService(llm);
    await experienceService.createExperience("user-1", {
      title: "CityU Computer Science",
      category: "education",
      content: "Computer Science master degree.",
    });
    await experienceService.createExperience("user-1", {
      title: "Scholarship",
      category: "award",
      content: "Academic scholarship.",
    });
    await experienceService.createExperience("user-1", {
      title: "Skills",
      category: "skill",
      content: "SQL, Python, Power BI.",
    });
    for (let i = 1; i <= 4; i += 1) {
      await experienceService.createExperience("user-1", {
        title: `Work ${i}`,
        category: i === 4 ? "work" : "internship",
        organization: `Company ${i}`,
        role: "Data Analyst",
        content: i <= 3
          ? `SQL Power BI dashboard metrics analytics priority work ${i}.`
          : "Customer support operations with little analytics evidence.",
      });
    }
    for (let i = 1; i <= 5; i += 1) {
      await experienceService.createExperience("user-1", {
        title: `Project ${i}`,
        category: "project",
        content: i <= 3
          ? `Python SQL data warehouse dashboard forecasting project ${i}.`
          : "Mobile UI animation practice with unrelated content.",
      });
    }

    await generationService.generateResumeFromJD({
      userId: "user-1",
      jdText: "Need SQL Python Power BI dashboard metrics data warehouse forecasting analytics.",
      targetRole: "Data Analyst",
    });

    expect(captured.filter((item) => item.category === "education")).toHaveLength(1);
    expect(captured.filter((item) => item.category === "award")).toHaveLength(1);
    expect(captured.filter((item) => item.category === "skill")).toHaveLength(1);
    expect(captured.filter((item) => item.category === "internship" || item.category === "work")).toHaveLength(3);
    expect(captured.filter((item) => item.category === "project")).toHaveLength(3);
    expect(captured.map((item) => item.title)).not.toContain("Work 4");
    expect(captured.map((item) => item.title)).not.toContain("Project 4");
    expect(captured.map((item) => item.title)).not.toContain("Project 5");
  });
});
