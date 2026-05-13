import {
  EvidenceChainBuilder,
  GraphViewBuilder,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
} from "../knowledge/index.js";
import type {
  Evidence,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../knowledge/index.js";

const experience: Experience = {
  id: "exp-1",
  userId: "user-demo",
  type: "work",
  organization: "Acme Corp",
  role: "Senior Frontend Engineer",
  summary: "Led the design system team and built a component library used by 12 product teams.",
  timeRange: {
    startDate: "2022-03-01",
    endDate: "2024-12-31",
  },
  star: {
    situation: "Acme needed a reusable frontend system across product teams.",
    task: "Lead the design system effort.",
    action: "Built React and TypeScript components with accessibility and performance standards.",
    result: "Reduced bundle size by 40% and shipped 60+ accessible components.",
  },
  evidenceIds: ["ev-1", "ev-2", "ev-3"],
  skillIds: ["skill-react", "skill-perf", "skill-a11y"],
  confidence: 0.95,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const evidences: Evidence[] = [
  {
    id: "ev-1",
    userId: "user-demo",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "metric",
    sourceRef: "seed:highlight[0]",
    excerpt: "Bundle size reduced from 320KB to 192KB (40% reduction).",
    confidence: 0.95,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "ev-2",
    userId: "user-demo",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "metric",
    sourceRef: "seed:highlight[1]",
    excerpt: "Shipped 60+ accessible components adopted by 12 product teams.",
    confidence: 0.98,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "ev-3",
    userId: "user-demo",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "project",
    sourceRef: "seed:description",
    excerpt: "Design system component library with React, TypeScript, and Storybook.",
    confidence: 1,
    createdAt: "2025-01-01T00:00:00Z",
  },
];

const skills: Skill[] = [
  {
    id: "skill-react",
    userId: "user-demo",
    name: "React",
    category: "technical",
    evidenceIds: ["ev-3"],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "skill-perf",
    userId: "user-demo",
    name: "Performance Optimization",
    category: "technical",
    evidenceIds: ["ev-1"],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "skill-a11y",
    userId: "user-demo",
    name: "Accessibility",
    category: "domain",
    evidenceIds: ["ev-2"],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  },
];

const requirement: JDRequirement = {
  id: "jd-req-1",
  userId: "user-demo",
  jdId: "jd-1",
  description: "Frontend engineer with React, performance optimization, and accessibility experience.",
  requiredSkillIds: ["skill-react", "skill-perf", "skill-a11y"],
  weight: 0.9,
  createdAt: "2025-01-01T00:00:00Z",
};

async function main() {
  const expRepo = new InMemoryExperienceRepository();
  const evRepo = new InMemoryEvidenceRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();

  await expRepo.save(experience);
  for (const evidence of evidences) {
    await evRepo.save(evidence);
  }

  const artifact: GeneratedArtifact = {
    id: "art-1",
    userId: "user-demo",
    type: "resume_bullet",
    content:
      "Led Acme's React design system, shipping 60+ accessible components and reducing bundle size by 40% across 12 product teams.",
    sourceExperienceIds: [experience.id],
    sourceEvidenceIds: ["ev-1", "ev-2", "ev-3"],
    matchedSkillIds: ["skill-react", "skill-perf", "skill-a11y"],
    targetJDId: requirement.jdId,
    targetRequirementIds: [requirement.id],
    targetRole: "Senior Frontend Engineer",
    scores: {
      overall: 0.88,
      requirementMatch: 0.9,
      evidenceStrength: 0.95,
    },
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await artifactRepo.save(artifact);

  const chainBuilder = new EvidenceChainBuilder(expRepo, evRepo);
  const chain = await chainBuilder.build(artifact, skills, [requirement]);
  const graph = new GraphViewBuilder().build(chain);

  console.log("=== Evidence Chain ===\n");
  console.log(JSON.stringify(chain, null, 2));
  console.log("\n=== Graph View ===\n");
  console.log(JSON.stringify(graph, null, 2));
}

main().catch(console.error);
