import { describe, expect, it } from "vitest";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../src/knowledge/index.js";
import type { JDRequirement } from "../src/knowledge/index.js";

describe("KeywordExperienceRetriever", () => {
  it("returns ranked experiences with matched skills and evidence", async () => {
    const experienceRepo = new InMemoryExperienceRepository();
    const evidenceRepo = new InMemoryEvidenceRepository();
    const skillRepo = new InMemorySkillRepository();
    const ingestion = new ExperienceIngestionService(
      experienceRepo,
      evidenceRepo,
      skillRepo,
    );

    const ingestResult = await ingestion.ingest({
      userId: "user-1",
      rawText: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React design system.",
        "Reduced bundle size by 40% through performance optimization.",
      ].join("\n"),
    });
    const reactSkill = ingestResult.skills.find((skill) => skill.name === "React");
    const perfSkill = ingestResult.skills.find(
      (skill) => skill.name === "Performance Optimization",
    );
    const requirement: JDRequirement = {
      id: "req-1",
      userId: "user-1",
      jdId: "jd-1",
      description: "React frontend performance optimization for design systems.",
      requiredSkillIds: [reactSkill?.id, perfSkill?.id].filter(Boolean) as string[],
      weight: 1,
      createdAt: "2025-01-01T00:00:00Z",
    };

    const retriever = new KeywordExperienceRetriever(
      experienceRepo,
      evidenceRepo,
      skillRepo,
    );
    const results = await retriever.retrieve({
      userId: "user-1",
      requirements: [requirement],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.experience.id).toBe(ingestResult.experience.id);
    expect(results[0]?.matchScore).toBeGreaterThan(0.6);
    expect(results[0]?.matchedSkillIds).toEqual(
      expect.arrayContaining(requirement.requiredSkillIds),
    );
    expect(results[0]?.matchedEvidenceIds.length).toBeGreaterThan(0);
  });
});
