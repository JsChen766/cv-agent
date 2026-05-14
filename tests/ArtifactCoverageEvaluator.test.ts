import { describe, expect, it } from "vitest";
import { ArtifactCoverageEvaluator } from "../src/application/evaluation/ArtifactCoverageEvaluator.js";
import type { RetrievedExperience } from "../src/knowledge/retrieval/ExperienceRetriever.js";
import type {
  Evidence,
  EvidenceChain,
  EvidenceRequirementMatch,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";

function makeRequirement(params: Partial<JDRequirement> = {}): JDRequirement {
  return {
    id: "req-react",
    userId: "user-1",
    jdId: "jd-1",
    description: "React experience",
    requiredSkillIds: ["skill-react"],
    weight: 1,
    createdAt: NOW,
    ...params,
  };
}

function makeSkill(params: Partial<Skill> = {}): Skill {
  return {
    id: "skill-react",
    userId: "user-1",
    name: "React",
    category: "technical",
    evidenceIds: ["ev-react"],
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeEvidence(params: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-react",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "skill_proof",
    sourceRef: "test",
    excerpt: "Built React components.",
    confidence: 0.9,
    createdAt: NOW,
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
    summary: "Built React components.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "x" },
    evidenceIds: ["ev-react"],
    skillIds: ["skill-react"],
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
    content: "Built React components.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-react"],
    matchedSkillIds: ["skill-react"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-react"],
    targetRole: "Engineer",
    scores: { overall: 0.7, requirementMatch: 0.7, evidenceStrength: 0.85 },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeMatch(params: Partial<EvidenceRequirementMatch> = {}): EvidenceRequirementMatch {
  const requirement = makeRequirement();
  const skill = makeSkill();
  const evidence = makeEvidence();
  return {
    requirement,
    matchedSkills: [skill],
    matchedExperiences: [makeExperience()],
    matchedEvidences: [evidence],
    matchScore: 0.7,
    matchReason: "Matched.",
    ...params,
  };
}

function makeChain(params: Partial<EvidenceChain> = {}): EvidenceChain {
  const artifact = makeArtifact();
  const evidence = makeEvidence();
  return {
    id: "chain-1",
    artifact,
    summary: "Backed by evidence.",
    requirementMatches: [makeMatch()],
    sourceExperiences: [makeExperience()],
    sourceEvidences: [evidence],
    sourceSkills: [makeSkill()],
    risk: {
      level: "low",
      truthfulnessRisk: "low",
      exaggerationRisk: "low",
      missingEvidenceClaims: [],
      exaggerationWarnings: [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: NOW,
    ...params,
  };
}

function makeRetrieved(params: {
  skill?: Skill;
  evidence?: Evidence;
} = {}): RetrievedExperience {
  const evidence = params.evidence ?? makeEvidence();
  const skill = params.skill ?? makeSkill({ evidenceIds: [evidence.id] });
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

describe("ArtifactCoverageEvaluator", () => {
  it("marks covered requirements", () => {
    const report = new ArtifactCoverageEvaluator().evaluate({
      userId: "user-1",
      jdId: "jd-1",
      requirements: [makeRequirement()],
      retrievedExperiences: [makeRetrieved()],
      artifacts: [makeArtifact()],
      evidenceChains: [makeChain()],
    });

    expect(report.items[0]?.status).toBe("covered");
    expect(report.coveredRequirementIds).toEqual(["req-react"]);
  });

  it("marks weakly covered requirements", () => {
    const report = new ArtifactCoverageEvaluator().evaluate({
      userId: "user-1",
      jdId: "jd-1",
      requirements: [makeRequirement()],
      retrievedExperiences: [makeRetrieved()],
      artifacts: [makeArtifact()],
      evidenceChains: [
        makeChain({
          risk: {
            level: "medium",
            truthfulnessRisk: "low",
            exaggerationRisk: "medium",
            missingEvidenceClaims: [],
            exaggerationWarnings: ["Unsupported claim."],
            notes: [],
          },
        }),
      ],
    });

    expect(report.items[0]?.status).toBe("weakly_covered");
    expect(report.weaklyCoveredRequirementIds).toEqual(["req-react"]);
  });

  it("marks evidence available but not used", () => {
    const report = new ArtifactCoverageEvaluator().evaluate({
      userId: "user-1",
      jdId: "jd-1",
      requirements: [makeRequirement()],
      retrievedExperiences: [makeRetrieved()],
      artifacts: [],
      evidenceChains: [],
    });

    expect(report.items[0]?.status).toBe("evidence_available_but_not_used");
    expect(report.items[0]?.supportingEvidenceIds).toEqual(["ev-react"]);
  });

  it("marks no evidence requirements", () => {
    const report = new ArtifactCoverageEvaluator().evaluate({
      userId: "user-1",
      jdId: "jd-1",
      requirements: [makeRequirement()],
      retrievedExperiences: [],
      artifacts: [],
      evidenceChains: [],
    });

    expect(report.items[0]?.status).toBe("no_evidence");
    expect(report.noEvidenceRequirementIds).toEqual(["req-react"]);
  });

  it("does not cover broad requirements from ordinary scope evidence", () => {
    const requirement = makeRequirement({
      id: "req-collab",
      description: "Cross-team collaboration",
      requiredSkillIds: [],
    });
    const artifact = makeArtifact({
      targetRequirementIds: ["req-collab"],
      content: "Led design system work for 12 teams.",
    });
    const evidence = makeEvidence({
      id: "ev-scope",
      excerpt: "Led design system work for 12 product teams.",
    });
    const chain = makeChain({
      artifact,
      sourceEvidences: [evidence],
      requirementMatches: [
        makeMatch({
          requirement,
          matchedEvidences: [evidence],
          matchScore: 0.7,
        }),
      ],
    });

    const report = new ArtifactCoverageEvaluator().evaluate({
      userId: "user-1",
      jdId: "jd-1",
      requirements: [requirement],
      retrievedExperiences: [makeRetrieved({ evidence })],
      artifacts: [artifact],
      evidenceChains: [chain],
    });

    expect(report.items[0]?.status).toBe("weakly_covered");
  });

  it("summarizes status counts", () => {
    const report = new ArtifactCoverageEvaluator().evaluate({
      userId: "user-1",
      jdId: "jd-1",
      requirements: [
        makeRequirement(),
        makeRequirement({ id: "req-missing", requiredSkillIds: ["skill-missing"] }),
      ],
      retrievedExperiences: [makeRetrieved()],
      artifacts: [makeArtifact()],
      evidenceChains: [makeChain()],
    });

    expect(report.summary).toContain("1/2 requirements covered");
    expect(report.summary).toContain("1 have no evidence");
  });
});
