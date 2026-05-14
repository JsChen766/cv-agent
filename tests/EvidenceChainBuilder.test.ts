import { describe, expect, it } from "vitest";
import { EvidenceChainBuilder } from "../src/knowledge/EvidenceChainBuilder.js";
import {
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
} from "../src/knowledge/index.js";
import type {
  Evidence,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";

function makeExperience(skillIds = ["skill-performance"]): Experience {
  return {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme Corp",
    role: "Frontend Engineer",
    summary: "Built frontend systems.",
    timeRange: { startDate: null, endDate: null },
    star: {
      situation: "Frontend work at Acme Corp.",
      task: "Improve frontend quality.",
      action: "Built systems.",
      result: "Reduced bundle size by 40%.",
    },
    evidenceIds: ["ev-performance"],
    skillIds,
    confidence: 0.85,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeEvidence(params: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-performance",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "result",
    sourceRef: "test",
    excerpt: "Reduced bundle size by 40% through lazy loading.",
    confidence: 0.92,
    createdAt: NOW,
    ...params,
  };
}

function makeSkill(params: Partial<Skill> = {}): Skill {
  return {
    id: "skill-performance",
    userId: "user-1",
    name: "Performance Optimization",
    category: "technical",
    evidenceIds: ["ev-performance"],
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeRequirement(params: Partial<JDRequirement> = {}): JDRequirement {
  return {
    id: "req-performance",
    userId: "user-1",
    jdId: "jd-1",
    description: "Performance optimization experience",
    requiredSkillIds: ["skill-performance"],
    weight: 1,
    createdAt: NOW,
    ...params,
  };
}

function makeArtifact(params: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Reduced bundle size by 40% through lazy loading.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-performance"],
    matchedSkillIds: ["skill-performance"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-performance"],
    targetRole: "Frontend Engineer",
    scores: {
      overall: 0.7,
      requirementMatch: 0.7,
      evidenceStrength: 0.85,
    },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

async function buildChain(params: {
  artifact?: Partial<GeneratedArtifact>;
  evidence?: Partial<Evidence>;
  experience?: Partial<Experience>;
  skills?: Skill[];
  requirements?: JDRequirement[];
}) {
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const experience = { ...makeExperience(), ...params.experience };
  const evidence = { ...makeEvidence(), ...params.evidence };
  await experienceRepo.save(experience);
  await evidenceRepo.save(evidence);

  const builder = new EvidenceChainBuilder(experienceRepo, evidenceRepo);
  return builder.build(
    makeArtifact(params.artifact),
    params.skills ?? [makeSkill()],
    params.requirements ?? [makeRequirement()],
  );
}

describe("EvidenceChainBuilder", () => {
  it("builds low risk for an artifact targeting one covered performance requirement", async () => {
    const chain = await buildChain({});

    expect(chain.requirementMatches).toHaveLength(1);
    expect(chain.risk.level).toBe("low");
    expect(chain.summary).toBe(
      "This resume bullet is backed by 1 evidence item and covers 1 target requirement.",
    );
  });

  it("does not penalize an artifact for unrelated requirements it does not target", async () => {
    const accessibilityRequirement = makeRequirement({
      id: "req-accessibility",
      description: "Accessibility experience",
      requiredSkillIds: ["skill-accessibility"],
    });

    const chain = await buildChain({
      requirements: [makeRequirement(), accessibilityRequirement],
    });

    expect(chain.requirementMatches.map((match) => match.requirement.id)).toEqual([
      "req-performance",
    ]);
    expect(chain.risk.level).toBe("low");
  });

  it("marks artifacts with no linked evidence as high risk", async () => {
    const chain = await buildChain({
      artifact: {
        sourceEvidenceIds: [],
        scores: { overall: 0.1, requirementMatch: 0.1, evidenceStrength: 0.2 },
        status: "needs_review",
      },
    });

    expect(chain.risk.level).toBe("high");
    expect(chain.risk.missingEvidenceClaims).toContain(
      "Generated artifact has no supporting evidence.",
    );
    expect(chain.summary).toContain("needs review because no supporting evidence is linked");
  });

  it("warns when artifact content contains an unsupported number", async () => {
    const chain = await buildChain({
      artifact: {
        content: "Reduced bundle size by 50% through lazy loading.",
      },
    });

    expect(chain.risk.level).toBe("high");
    expect(chain.risk.exaggerationWarnings.some((warning) => warning.includes("50%"))).toBe(true);
  });

  it("warns when high-risk claim phrases are not supported by evidence", async () => {
    const chain = await buildChain({
      artifact: {
        content: "Gathered requirements for design system adoption.",
        sourceEvidenceIds: ["ev-design-system"],
        matchedSkillIds: ["skill-design-system"],
        targetRequirementIds: ["req-design-system"],
      },
      evidence: {
        id: "ev-design-system",
        evidenceType: "scope",
        excerpt: "Worked with 12 product teams on design system adoption.",
      },
      experience: {
        evidenceIds: ["ev-design-system"],
        skillIds: ["skill-design-system"],
      },
      skills: [
        makeSkill({
          id: "skill-design-system",
          name: "Design System",
          category: "domain",
          evidenceIds: ["ev-design-system"],
        }),
      ],
      requirements: [
        makeRequirement({
          id: "req-design-system",
          description: "Design system experience",
          requiredSkillIds: ["skill-design-system"],
        }),
      ],
    });

    expect(chain.risk.level).toBe("medium");
    expect(chain.risk.exaggerationWarnings.some((warning) => warning.includes("gathered requirements"))).toBe(true);
  });

  it("does not warn when a result claim is directly supported", async () => {
    const chain = await buildChain({});

    expect(chain.risk.exaggerationWarnings).toEqual([]);
  });

  it("adds a note for unknown target requirement IDs without crashing", async () => {
    const chain = await buildChain({
      artifact: {
        targetRequirementIds: ["req-missing"],
      },
    });

    expect(chain.risk.notes.some((note) => note.includes("req-missing"))).toBe(true);
  });
});
