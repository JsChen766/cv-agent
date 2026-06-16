import { describe, expect, it } from "vitest";
import {
  ClaimGraphIndexer,
  EvidenceIndexMaintenanceService,
  EvidenceRAGService,
  InMemoryClaimGraphRepository,
} from "../src/rag/evidence/index.js";
import { ExperienceService, InMemoryProductExperienceRepository } from "../src/product/index.js";

describe("Evidence RAG v5 finalization", () => {
  it("uses domain-aware hybrid retrieval instead of treating a generic Python overlap as full AI-role evidence", async () => {
    const claimRepository = new InMemoryClaimGraphRepository();
    const indexer = new ClaimGraphIndexer(claimRepository);
    const experienceService = new ExperienceService(new InMemoryProductExperienceRepository(), indexer);
    const generic = await experienceService.createExperience("user-1", {
      title: "Building Monitoring System",
      category: "project",
      content: "Used Python to process acoustic sensor signals for building health monitoring.",
      structured: { techStack: ["Python"], highlights: ["Processed acoustic sensor signals"] },
    });
    const relevant = await experienceService.createExperience("user-1", {
      title: "Multimodal LLM Agent Research",
      category: "project",
      content: "Developed a multimodal LLM agent and evaluated retrieval-augmented generation with PyTorch on a benchmark dataset.",
      structured: { techStack: ["PyTorch", "LLM", "RAG"], highlights: ["Evaluated a multimodal LLM agent"] },
    });
    const service = new EvidenceRAGService({ experienceService, claimGraphRepository: claimRepository });
    const pack = await service.buildEvidencePack({
      userId: "user-1",
      targetRole: "AI Algorithm Engineer Intern",
      roleFamily: "ai_ml",
      jdText: "Develop LLM, multimodal VQA, RAG and reinforcement-learning algorithms. Strong Python and PyTorch skills are required.",
    });

    expect(pack.version).toBe("evidence-rag-v5");
    expect(pack.retrievalTrace[0]?.experienceId).toBe(relevant.experience.id);
    expect(pack.allowedClaims.some((claim) => claim.experienceId === relevant.experience.id && /llm|multimodal|rag/i.test(claim.claim))).toBe(true);
    expect(pack.allowedClaims.some((claim) => claim.experienceId === generic.experience.id && /llm|vqa|rag|reinforcement/i.test(claim.claim))).toBe(false);
    expect(pack.diagnostics?.retrievalEvaluation).toBeDefined();
  });

  it("keeps unsupported leadership and metrics outside the factual boundary", async () => {
    const claimRepository = new InMemoryClaimGraphRepository();
    const indexer = new ClaimGraphIndexer(claimRepository);
    const experienceService = new ExperienceService(new InMemoryProductExperienceRepository(), indexer);
    await experienceService.createExperience("user-1", {
      title: "User Research Project",
      category: "project",
      content: "Participated in interviews and summarized user feedback.",
    });
    const service = new EvidenceRAGService({ experienceService, claimGraphRepository: claimRepository });
    const pack = await service.buildEvidencePack({
      userId: "user-1",
      jdText: "Lead a cross-functional team and improve retention by 30% through user research.",
    });
    const verified = service.verifyGeneratedVariants([{
      id: "variant-1",
      userId: "user-1",
      content: "Led a cross-functional team and improved retention by 30% through user research.",
      createdAt: new Date().toISOString(),
    }], pack)[0];

    expect(verified.riskSummary?.level).toBe("high");
    expect(verified.riskSummary?.unsupportedClaims?.some((item) => item.includes("30%"))).toBe(true);
    expect(verified.groundingTrace?.some((item) => item.support === "unsupported")).toBe(true);
    expect(verified.sourceEvidenceIds?.length ?? 0).toBeLessThanOrEqual(pack.allowedClaims.length);
  });

  it("can backfill persistent claims for experiences created before claim indexing was enabled", async () => {
    const experienceRepository = new InMemoryProductExperienceRepository();
    const experienceService = new ExperienceService(experienceRepository);
    await experienceService.createExperience("user-1", {
      title: "Legacy RAG Project",
      category: "project",
      content: "Implemented a retrieval-augmented generation pipeline with Python.",
    });
    const claimRepository = new InMemoryClaimGraphRepository();
    const indexer = new ClaimGraphIndexer(claimRepository);
    const maintenance = new EvidenceIndexMaintenanceService(experienceService, indexer, claimRepository);
    const service = new EvidenceRAGService({
      experienceService,
      claimGraphRepository: claimRepository,
      indexMaintenanceService: maintenance,
    });
    const report = await service.reindexUserExperiences({ userId: "user-1" });

    expect(report?.indexedExperiences).toBe(1);
    expect(report?.activeClaims).toBeGreaterThan(0);
  });
});
