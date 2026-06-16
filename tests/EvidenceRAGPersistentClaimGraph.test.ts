import { describe, expect, it } from "vitest";
import {
  ClaimGraphIndexer,
  EvidenceRAGService,
  InMemoryClaimGraphRepository,
  PersistentClaimRetriever,
} from "../src/rag/evidence/index.js";
import {
  ExperienceService,
  InMemoryProductExperienceRepository,
} from "../src/product/index.js";

describe("Evidence RAG v2 persistent claim graph", () => {
  it("indexes claims when an experience is created and retrieves them for JD grounding", async () => {
    const claimRepository = new InMemoryClaimGraphRepository();
    const indexer = new ClaimGraphIndexer(claimRepository);
    const experienceService = new ExperienceService(new InMemoryProductExperienceRepository(), indexer);

    const { experience } = await experienceService.createExperience("user-1", {
      title: "Market Research Agent",
      category: "project",
      content: "Built a Python agent workflow to collect market information, summarize reports, and analyze user feedback for product decisions.",
      tags: ["Python", "agent", "market research"],
      structured: {
        techStack: ["Python", "LLM agent"],
        highlights: ["Built a Python agent workflow", "Summarized market reports", "Analyzed user feedback"],
      },
    });

    const claims = await claimRepository.listActiveClaimsByUser("user-1");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((claim) => claim.experienceId === experience.id)).toBe(true);

    const evidenceRAG = new EvidenceRAGService({ experienceService, claimGraphRepository: claimRepository });
    const pack = await evidenceRAG.buildEvidencePack({
      userId: "user-1",
      jdText: "Required: Python, market research, user feedback analysis, and agent workflow experience.",
      targetRole: "Product Analyst Intern",
    });

    expect(["evidence-rag-v2", "evidence-rag-v4", "evidence-rag-v5"]).toContain(pack.version);
    expect(pack.allowedClaims.length).toBeGreaterThan(0);
    expect(pack.allowedClaims.some((claim) => claim.claimId?.startsWith("pclaim-"))).toBe(true);
    expect(pack.retrievalTrace.some((trace) => trace.source === "persistent_claim")).toBe(true);
    expect(pack.graphLinks.some((link) => link.sourceType === "experience" && link.targetType === "claim")).toBe(true);
  });

  it("marks old claims stale when an experience is re-indexed", async () => {
    const claimRepository = new InMemoryClaimGraphRepository();
    const indexer = new ClaimGraphIndexer(claimRepository);
    const experienceService = new ExperienceService(new InMemoryProductExperienceRepository(), indexer);

    const { experience } = await experienceService.createExperience("user-1", {
      title: "Research Project",
      category: "project",
      content: "Conducted interviews and summarized findings.",
    });
    const firstClaims = await claimRepository.listActiveClaimsByUser("user-1");
    expect(firstClaims.length).toBeGreaterThan(0);

    await experienceService.createRevision("user-1", experience.id, {
      content: "Analyzed survey data with Python and created product insight reports.",
      structured: { techStack: ["Python"], highlights: ["Analyzed survey data with Python"] },
    });

    const activeClaims = await claimRepository.listActiveClaimsByUser("user-1");
    expect(activeClaims.length).toBeGreaterThan(0);
    expect(activeClaims.every((claim) => claim.status === "active")).toBe(true);
    expect(activeClaims.some((claim) => claim.claim.includes("Python") || claim.skills.includes("Python"))).toBe(true);
  });

  it("falls back to dynamic experience retrieval when no persistent claim matches", async () => {
    const claimRepository = new InMemoryClaimGraphRepository();
    const experienceService = new ExperienceService(new InMemoryProductExperienceRepository());
    await experienceService.createExperience("user-1", {
      title: "React Dashboard",
      category: "project",
      content: "Built React components and improved dashboard performance.",
      structured: { techStack: ["React", "TypeScript"] },
    });

    const evidenceRAG = new EvidenceRAGService({ experienceService, claimGraphRepository: claimRepository });
    const pack = await evidenceRAG.buildEvidencePack({
      userId: "user-1",
      jdText: "Need React and TypeScript dashboard experience.",
    });

    expect(pack.allowedClaims.length).toBeGreaterThan(0);
    expect(pack.retrievalTrace.some((trace) => trace.source === "raw_experience")).toBe(true);
  });
});
