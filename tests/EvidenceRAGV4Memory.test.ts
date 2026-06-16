import { describe, expect, it } from "vitest";
import {
  ClaimGraphIndexer,
  EvidenceRAGService,
  InMemoryClaimGraphRepository,
} from "../src/rag/evidence/index.js";
import {
  ExperienceService,
  InMemoryProductExperienceRepository,
} from "../src/product/index.js";

describe("Evidence RAG v5 long-term evidence memory", () => {
  it("records generation usage and variant acceptance stats for claims", async () => {
    const claimRepository = new InMemoryClaimGraphRepository();
    const indexer = new ClaimGraphIndexer(claimRepository);
    const experienceService = new ExperienceService(new InMemoryProductExperienceRepository(), indexer);
    await experienceService.createExperience("user-1", {
      title: "Product Research Project",
      category: "project",
      content: "Conducted user interviews and analyzed feedback to propose product improvement ideas.",
      structured: { highlights: ["Conducted user interviews", "Analyzed feedback"] },
    });

    const evidenceRAG = new EvidenceRAGService({ experienceService, claimGraphRepository: claimRepository });
    const pack = await evidenceRAG.buildEvidencePack({
      userId: "user-1",
      jdText: "Need user research and product feedback analysis experience.",
      targetRole: "Product Analyst Intern",
      roleFamily: "product",
    });

    expect(pack.version).toBe("evidence-rag-v5");
    expect(pack.allowedClaims.length).toBeGreaterThan(0);

    const variant = {
      id: "variant-1",
      userId: "user-1",
      content: "Conducted user interviews and analyzed feedback for product improvement.",
      sourceExperienceIds: [pack.allowedClaims[0].experienceId],
      sourceEvidenceIds: [pack.allowedClaims[0].claimId ?? pack.allowedClaims[0].id],
      scores: { overall: 0.8, relevance: 0.8, evidenceStrength: 0.8 },
      createdAt: new Date().toISOString(),
    };

    await evidenceRAG.recordGenerationUsage({
      userId: "user-1",
      generationId: "generation-1",
      jdId: "jd-1",
      targetRole: "Product Analyst Intern",
      roleFamily: "product",
      evidencePack: pack,
      variants: [variant],
    });
    await evidenceRAG.recordVariantDecision({
      userId: "user-1",
      generationId: "generation-1",
      variantId: "variant-1",
      action: "accepted",
      finalText: variant.content,
      claimIds: variant.sourceEvidenceIds,
    });

    const memory = await evidenceRAG.buildLongTermMemory({
      userId: "user-1",
      claimIds: variant.sourceEvidenceIds,
      roleFamily: "product",
    });

    expect(memory?.claimUsageStats.length).toBeGreaterThan(0);
    expect(memory?.claimUsageStats[0].generatedCount).toBeGreaterThan(0);
    expect(memory?.claimUsageStats[0].acceptedCount).toBeGreaterThan(0);
    expect(memory?.claimUsageStats[0].acceptanceRate).toBeGreaterThan(0);
    expect(memory?.roleSpecificEffectiveness.length).toBeGreaterThan(0);
  });
});
