import { describe, expect, it } from "vitest";
import { DeterministicCoverageGapAdvisor } from "../src/application/coverage-gaps/DeterministicCoverageGapAdvisor.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import type { RetrievedExperience } from "../src/knowledge/retrieval/ExperienceRetriever.js";
import type {
  Evidence,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";

function makeRequirement(params: Partial<JDRequirement> = {}): JDRequirement {
  return {
    id: "req-api",
    userId: "user-1",
    jdId: "jd-1",
    description: "API Integration",
    requiredSkillIds: ["skill-api"],
    weight: 1,
    createdAt: NOW,
    ...params,
  };
}

function makeEvidence(params: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-api",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "skill_proof",
    sourceRef: "test",
    excerpt:
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
    confidence: 0.9,
    createdAt: NOW,
    ...params,
  };
}

function makeSkill(params: Partial<Skill> = {}): Skill {
  return {
    id: "skill-api",
    userId: "user-1",
    name: "API Integration",
    category: "technical",
    evidenceIds: ["ev-api"],
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeExperience(params: Partial<Experience> = {}): Experience {
  return {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme",
    role: "Engineer",
    summary: "Built frontend systems.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "x" },
    evidenceIds: ["ev-api"],
    skillIds: ["skill-api"],
    confidence: 0.8,
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeArtifact(params: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Built API integrations.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-api"],
    matchedSkillIds: ["skill-api"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-api"],
    targetRole: "Engineer",
    scores: { overall: 0.7, requirementMatch: 0.7, evidenceStrength: 0.8 },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeRetrieved(evidence = makeEvidence(), skill = makeSkill()): RetrievedExperience {
  return {
    experience: makeExperience({ evidenceIds: [evidence.id], skillIds: [skill.id] }),
    evidences: [evidence],
    skills: [skill],
    matchedEvidences: [evidence],
    matchedSkills: [skill],
    matchedRequirements: [],
    matchScore: 0.8,
    matchedRequirementIds: [],
    matchedEvidenceIds: [evidence.id],
    matchedSkillIds: [skill.id],
    reason: "Matched.",
  };
}

function makeCoverageReport(items: ArtifactCoverageReport["items"]): ArtifactCoverageReport {
  return {
    id: "coverage-1",
    userId: "user-1",
    jdId: "jd-1",
    totalRequirements: items.length,
    coveredRequirementIds: items.filter((item) => item.status === "covered").map((item) => item.requirement.id),
    weaklyCoveredRequirementIds: items.filter((item) => item.status === "weakly_covered").map((item) => item.requirement.id),
    evidenceAvailableButNotUsedRequirementIds: items.filter((item) => item.status === "evidence_available_but_not_used").map((item) => item.requirement.id),
    noEvidenceRequirementIds: items.filter((item) => item.status === "no_evidence").map((item) => item.requirement.id),
    notTargetedRequirementIds: items.filter((item) => item.status === "not_targeted").map((item) => item.requirement.id),
    items,
    summary: "Coverage summary.",
    createdAt: NOW,
  };
}

async function advise(report: ArtifactCoverageReport, retrieved = [makeRetrieved()]) {
  return new DeterministicCoverageGapAdvisor().advise({
    userId: "user-1",
    jdId: "jd-1",
    coverageReport: report,
    retrievedExperiences: retrieved,
    artifacts: [makeArtifact()],
  });
}

describe("DeterministicCoverageGapAdvisor", () => {
  it("turns evidence_available_but_not_used into a missing artifact suggestion", async () => {
    const requirement = makeRequirement();
    const report = await advise(makeCoverageReport([{
      requirement,
      status: "evidence_available_but_not_used",
      coveredByArtifactIds: [],
      supportingEvidenceIds: ["ev-api"],
      supportingSkillIds: ["skill-api"],
      reason: "Evidence exists.",
      suggestions: [],
    }]));

    expect(report.items[0]?.gapType).toBe("missing_artifact");
    expect(report.items[0]?.severity).toBe("medium");
    expect(report.items[0]?.supplementalArtifactSuggestions).toHaveLength(1);
    expect(report.items[0]?.evidenceRequestSuggestions).toHaveLength(0);
  });

  it("builds API supplemental bullets only from existing evidence ids", async () => {
    const report = await advise(makeCoverageReport([{
      requirement: makeRequirement(),
      status: "evidence_available_but_not_used",
      coveredByArtifactIds: [],
      supportingEvidenceIds: ["ev-api", "missing-ev"],
      supportingSkillIds: ["skill-api"],
      reason: "Evidence exists.",
      suggestions: [],
    }]));

    const suggestion = report.items[0]?.supplementalArtifactSuggestions[0];
    expect(suggestion?.content).toContain("API");
    expect(suggestion?.sourceEvidenceIds).toEqual(["ev-api"]);
    expect(suggestion?.targetRequirementIds).toEqual(["req-api"]);
    expect(suggestion?.riskLevel).toBe("low");
  });

  it("turns no_evidence into a missing evidence request", async () => {
    const report = await advise(makeCoverageReport([{
      requirement: makeRequirement({
        id: "req-collab",
        description: "Cross-team collaboration",
        requiredSkillIds: [],
      }),
      status: "no_evidence",
      coveredByArtifactIds: [],
      supportingEvidenceIds: [],
      supportingSkillIds: [],
      reason: "No evidence.",
      suggestions: [],
    }]), []);

    expect(report.items[0]?.gapType).toBe("missing_evidence");
    expect(report.items[0]?.severity).toBe("high");
    expect(report.items[0]?.supplementalArtifactSuggestions).toHaveLength(0);
    expect(report.items[0]?.evidenceRequestSuggestions[0]?.expectedEvidenceType).toBe("collaboration");
  });

  it("turns weakly covered requirements into weak coverage gaps", async () => {
    const report = await advise(makeCoverageReport([{
      requirement: makeRequirement(),
      status: "weakly_covered",
      coveredByArtifactIds: ["artifact-1"],
      supportingEvidenceIds: ["ev-api"],
      supportingSkillIds: ["skill-api"],
      reason: "Weak.",
      suggestions: [],
    }]));

    expect(report.items[0]?.gapType).toBe("weak_coverage");
    expect(report.items[0]?.existingArtifactIds).toEqual(["artifact-1"]);
    expect(report.items[0]?.supplementalArtifactSuggestions[0]?.riskLevel).toBe("medium");
    expect(report.items[0]?.evidenceRequestSuggestions.length).toBeGreaterThan(0);
  });

  it("does not generate gap items for covered requirements", async () => {
    const report = await advise(makeCoverageReport([{
      requirement: makeRequirement(),
      status: "covered",
      coveredByArtifactIds: ["artifact-1"],
      supportingEvidenceIds: ["ev-api"],
      supportingSkillIds: ["skill-api"],
      reason: "Covered.",
      suggestions: [],
    }]));

    expect(report.items).toHaveLength(0);
    expect(report.supplementalArtifactCount).toBe(0);
  });
});
