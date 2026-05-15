import { describe, expect, it } from "vitest";
import { DeterministicArtifactCritic } from "../src/application/critique/DeterministicArtifactCritic.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import type {
  EvidenceChain,
  Evidence,
  GeneratedArtifact,
  JDRequirement,
} from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";

function makeArtifact(params: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Reduced bundle size by 40%.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: ["skill-performance"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Engineer",
    scores: { overall: 0.7, requirementMatch: 0.7, evidenceStrength: 0.85 },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeChain(
  artifact: GeneratedArtifact,
  risk: EvidenceChain["risk"] = {
    level: "low",
    truthfulnessRisk: "low",
    exaggerationRisk: "low",
    missingEvidenceClaims: [],
    exaggerationWarnings: [],
    notes: [],
  },
  sourceEvidences: Evidence[] = [],
): EvidenceChain {
  return {
    id: `chain-${artifact.id}`,
    artifact,
    summary: "summary",
    requirementMatches: [],
    sourceExperiences: [],
    sourceEvidences,
    sourceSkills: [],
    risk,
    scores: artifact.scores,
    createdAt: NOW,
  };
}

function makeEvidence(excerpt: string): Evidence {
  return {
    id: "ev-1",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "manual",
    evidenceType: "metric",
    sourceRef: "test",
    excerpt,
    confidence: 0.9,
    metadata: {},
    createdAt: NOW,
  };
}

function makeCoverageReport(params: Partial<ArtifactCoverageReport> = {}): ArtifactCoverageReport {
  const requirement: JDRequirement = {
    id: "req-1",
    userId: "user-1",
    jdId: "jd-1",
    description: "Performance",
    requiredSkillIds: [],
    weight: 1,
    createdAt: NOW,
  };
  return {
    id: "coverage-1",
    jdId: "jd-1",
    userId: "user-1",
    totalRequirements: 1,
    coveredRequirementIds: ["req-1"],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: [],
    noEvidenceRequirementIds: [],
    notTargetedRequirementIds: [],
    items: [
      {
        requirement,
        status: "covered",
        coveredByArtifactIds: ["artifact-1"],
        supportingEvidenceIds: ["ev-1"],
        supportingSkillIds: [],
        reason: "Covered.",
        suggestions: [],
      },
    ],
    summary: "1/1 requirements covered.",
    createdAt: NOW,
    ...params,
  };
}

describe("DeterministicArtifactCritic", () => {
  it("marks low risk artifacts as pass", async () => {
    const artifact = makeArtifact();
    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact)],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("pass");
  });

  it("marks medium risk artifacts as revise", async () => {
    const artifact = makeArtifact();
    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [
        makeChain(artifact, {
          level: "medium",
          truthfulnessRisk: "low",
          exaggerationRisk: "medium",
          missingEvidenceClaims: [],
          exaggerationWarnings: ["Unsupported claim."],
          notes: [],
        }),
      ],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("revise");
    expect(report.items[0]?.unsupportedClaims).toEqual(["Unsupported claim."]);
  });

  it("marks high risk artifacts as reject", async () => {
    const artifact = makeArtifact();
    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [
        makeChain(artifact, {
          level: "high",
          truthfulnessRisk: "high",
          exaggerationRisk: "low",
          missingEvidenceClaims: ["Generated artifact has no supporting evidence."],
          exaggerationWarnings: [],
          notes: [],
        }),
      ],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("reject");
    expect(report.items[0]?.missingEvidence).toEqual([
      "Generated artifact has no supporting evidence.",
    ]);
  });

  it("summarizes pass, revise, reject, and unused evidence counts", async () => {
    const pass = makeArtifact({ id: "artifact-pass" });
    const revise = makeArtifact({ id: "artifact-revise" });
    const reject = makeArtifact({ id: "artifact-reject" });
    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [pass, revise, reject],
      evidenceChains: [
        makeChain(pass),
        makeChain(revise, {
          level: "medium",
          truthfulnessRisk: "low",
          exaggerationRisk: "medium",
          missingEvidenceClaims: [],
          exaggerationWarnings: ["Unsupported claim."],
          notes: [],
        }),
        makeChain(reject, {
          level: "high",
          truthfulnessRisk: "high",
          exaggerationRisk: "low",
          missingEvidenceClaims: ["Missing evidence."],
          exaggerationWarnings: [],
          notes: [],
        }),
      ],
      coverageReport: makeCoverageReport({
        evidenceAvailableButNotUsedRequirementIds: ["req-api"],
      }),
    });

    expect(report.summary).toContain("3 artifacts reviewed");
    expect(report.summary).toContain("1 passed");
    expect(report.summary).toContain("1 need revision");
    expect(report.summary).toContain("1 rejected");
    expect(report.summary).toContain("1 requirement has evidence available but is not covered");
  });

  it("returns one critique item with artifactId for every artifact", async () => {
    const artifacts = [
      makeArtifact({ id: "artifact-1" }),
      makeArtifact({ id: "artifact-2" }),
      makeArtifact({ id: "artifact-3" }),
    ];
    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts,
      evidenceChains: artifacts.map((artifact) => makeChain(artifact)),
      coverageReport: makeCoverageReport(),
    });
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id));

    expect(report.items).toHaveLength(artifacts.length);
    expect(report.items.every((item) => item.artifactId.length > 0)).toBe(true);
    expect(report.items.every((item) => artifactIds.has(item.artifactId))).toBe(true);
  });

  it("throws a clear error when an artifact has no id", async () => {
    const artifact = {
      ...makeArtifact(),
      id: undefined,
    } as unknown as GeneratedArtifact;

    await expect(
      new DeterministicArtifactCritic().critique({
        userId: "user-1",
        jdId: "jd-1",
        artifacts: [artifact],
        evidenceChains: [],
        coverageReport: makeCoverageReport(),
      }),
    ).rejects.toThrow("Cannot critique artifact without artifact.id");
  });

  it("revises needs_confirmation artifacts and includes confirmation questions", async () => {
    const artifact = makeArtifact({
      metadata: {
        enhancement: {
          status: "needs_confirmation",
          claims: [{
            text: "Reduced reporting time by 80%.",
            supportLevel: "needs_user_confirmation",
            riskLevel: "medium",
            evidenceIds: [],
            sourceExperienceIds: ["exp-1"],
            userConfirmationPrompt: "Can you confirm the 80% reduction?",
          }],
          confirmationQuestions: ["Can you confirm the 80% reduction?"],
          enhancementStrategy: "confirmation_needed",
        },
      },
    });

    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact)],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("revise");
    expect(report.items[0]?.truthfulnessRisk).toBe("medium");
    expect(report.items[0]?.missingEvidence).toContain("Can you confirm the 80% reduction?");
    expect(report.items[0]?.rewriteSuggestions).toContain("Can you confirm the 80% reduction?");
    expect(report.items[0]?.confirmationQuestions).toEqual(["Can you confirm the 80% reduction?"]);
  });

  it("rejects unsafe artifacts from enhancement metadata", async () => {
    const artifact = makeArtifact({
      metadata: {
        enhancement: {
          status: "unsafe",
          claims: [{
            text: "Owned company-wide strategy without evidence.",
            supportLevel: "unsupported",
            riskLevel: "high",
            evidenceIds: [],
            sourceExperienceIds: [],
          }],
          confirmationQuestions: [],
          enhancementStrategy: "unsafe_candidate",
        },
      },
    });

    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact)],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("reject");
    expect(report.items[0]?.truthfulnessRisk).toBe("high");
    expect(report.items[0]?.exaggerationRisk).toBe("high");
    expect(report.items[0]?.unsupportedClaims).toContain("Owned company-wide strategy without evidence.");
  });

  it("includes unsupported enhancement claims in unsupportedClaims", async () => {
    const artifact = makeArtifact({
      metadata: {
        enhancement: {
          status: "ready",
          claims: [{
            text: "Unsupported executive ownership claim.",
            supportLevel: "unsupported",
            riskLevel: "medium",
            evidenceIds: [],
            sourceExperienceIds: [],
          }],
          confirmationQuestions: [],
          enhancementStrategy: "evidence_rewrite",
        },
      },
    });

    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact)],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("reject");
    expect(report.items[0]?.unsupportedClaims).toContain("Unsupported executive ownership claim.");
    expect(report.items[0]?.claimReviews?.[0]).toMatchObject({
      claimText: "Unsupported executive ownership claim.",
      supportLevel: "unsupported",
      verdict: "reject",
    });
  });

  it("revises artifacts with numeric claims missing from evidence and no enhancement warning", async () => {
    const artifact = makeArtifact({
      content: "Improved reporting accuracy by 35%.",
      metadata: {
        enhancement: {
          status: "ready",
          claims: [{
            text: "Improved reporting accuracy by 35%.",
            supportLevel: "supported",
            riskLevel: "low",
            evidenceIds: ["ev-1"],
            sourceExperienceIds: ["exp-1"],
          }],
          confirmationQuestions: [],
          enhancementStrategy: "evidence_rewrite",
        },
      },
    });

    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact, undefined, [makeEvidence("Built reporting dashboards.")])],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("revise");
    expect(report.items[0]?.truthfulnessRisk).toBe("medium");
    expect(report.items[0]?.missingEvidence).toContain("Numeric claim requires confirmation: 35%");
    expect(report.items[0]?.rewriteSuggestions).toContain(
      "Confirm the numeric metric or rewrite the artifact without unsupported numbers.",
    );
    expect(report.items[0]?.claimReviews?.some((claim) =>
      claim.supportLevel === "needs_user_confirmation" &&
      claim.reason.includes("35%")
    )).toBe(true);
  });

  it("does not upgrade numeric claims already present in evidence", async () => {
    const artifact = makeArtifact({
      content: "Improved reporting accuracy by 40%.",
    });

    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact, undefined, [makeEvidence("Improved reporting accuracy by 40%.")])],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("pass");
    expect(report.items[0]?.missingEvidence).toEqual([]);
  });

  it("does not duplicate numeric missing evidence when enhancement already requires confirmation", async () => {
    const artifact = makeArtifact({
      content: "Improved reporting accuracy by 35%.",
      metadata: {
        enhancement: {
          status: "needs_confirmation",
          claims: [{
            text: "Improved reporting accuracy by 35%.",
            supportLevel: "needs_user_confirmation",
            riskLevel: "medium",
            evidenceIds: [],
            sourceExperienceIds: [],
            userConfirmationPrompt: "Can you confirm 35%?",
          }],
          confirmationQuestions: ["Can you confirm 35%?"],
          enhancementStrategy: "confirmation_needed",
        },
      },
    });

    const report = await new DeterministicArtifactCritic().critique({
      userId: "user-1",
      jdId: "jd-1",
      artifacts: [artifact],
      evidenceChains: [makeChain(artifact, undefined, [makeEvidence("Built reporting dashboards.")])],
      coverageReport: makeCoverageReport(),
    });

    expect(report.items[0]?.verdict).toBe("revise");
    expect(report.items[0]?.missingEvidence.filter((item) =>
      item.startsWith("Numeric claim requires confirmation")
    )).toHaveLength(0);
    expect(report.items[0]?.missingEvidence).toContain("Can you confirm 35%?");
  });
});
