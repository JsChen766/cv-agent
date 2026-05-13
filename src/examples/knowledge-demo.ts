import {
  InMemoryExperienceRepository,
  InMemoryEvidenceRepository,
  InMemoryGeneratedArtifactRepository,
  EvidenceChainBuilder,
  GraphViewBuilder,
} from "../knowledge/index.js";
import type {
  Experience,
  Evidence,
  Skill,
  JDRequirement,
  GeneratedArtifact,
} from "../knowledge/index.js";

// ── Mock data ──────────────────────────────────────────────────

const experience: Experience = {
  id: "exp-1",
  title: "Senior Frontend Engineer",
  company: "Acme Corp",
  startDate: "2022-03-01",
  endDate: "2024-12-31",
  description: "Led the design system team, built a component library used by 12 product teams.",
  highlights: [
    "Reduced bundle size by 40% through tree-shaking and lazy loading",
    "Designed and shipped 60+ accessible components adopted by 12 teams",
    "Mentored 4 junior engineers on performance and accessibility",
  ],
  skillIds: ["skill-react", "skill-perf", "skill-a11y"],
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const evidences: Evidence[] = [
  {
    id: "ev-1",
    experienceId: "exp-1",
    type: "metric",
    content: "Bundle size reduced from 320KB to 192KB (40% reduction)",
    source: "highlight[0]",
    confidence: 0.95,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "ev-2",
    experienceId: "exp-1",
    type: "bullet",
    content: "Shipped 60+ accessible components (WCAG AA) adopted by 12 product teams",
    source: "highlight[1]",
    confidence: 0.98,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "ev-3",
    experienceId: "exp-1",
    type: "project",
    content: "Design system component library with React, TypeScript, and Storybook",
    source: "description",
    confidence: 1.0,
    createdAt: "2025-01-01T00:00:00Z",
  },
];

const skills: Skill[] = [
  {
    id: "skill-react",
    name: "React",
    category: "technical",
    evidenceIds: ["ev-2", "ev-3"],
  },
  {
    id: "skill-perf",
    name: "Performance Optimization",
    category: "technical",
    evidenceIds: ["ev-1"],
  },
  {
    id: "skill-a11y",
    name: "Accessibility (WCAG)",
    category: "domain",
    evidenceIds: ["ev-2"],
  },
];

const requirement: JDRequirement = {
  id: "jd-req-1",
  jdId: "jd-1",
  description: "5+ years of frontend experience with React, performance optimization, and accessibility",
  requiredSkillIds: ["skill-react", "skill-perf", "skill-a11y"],
  weight: 0.9,
};

// ── Mock bullet generation (simulates LLM output) ──────────────

function mockGenerateBullet(exp: Experience, _req: JDRequirement): string {
  return `Led design system initiative at ${exp.company}, shipping 60+ WCAG AA compliant components that reduced bundle size by 40% across 12 product teams.`;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  // Repositories
  const expRepo = new InMemoryExperienceRepository();
  const evRepo = new InMemoryEvidenceRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();

  // Seed data
  await expRepo.save(experience);
  for (const ev of evidences) await evRepo.save(ev);

  // Generate bullet & create artifact
  const bullet = mockGenerateBullet(experience, requirement);
  const artifact: GeneratedArtifact = {
    id: "art-1",
    experienceId: experience.id,
    jdRequirementId: requirement.id,
    bulletText: bullet,
    score: 0.88,
    matchedSkillIds: ["skill-react", "skill-perf", "skill-a11y"],
    matchedEvidenceIds: ["ev-1", "ev-2", "ev-3"],
    createdAt: new Date().toISOString(),
  };
  await artifactRepo.save(artifact);

  // Build evidence chain
  const chainBuilder = new EvidenceChainBuilder(expRepo, evRepo);
  const chain = await chainBuilder.build(artifact, skills, requirement);

  // Build graph view
  const graphBuilder = new GraphViewBuilder();
  const graph = graphBuilder.build(chain);

  // Output
  console.log("=== Evidence Chain ===\n");
  console.log(JSON.stringify(chain, null, 2));

  console.log("\n=== Graph View ===\n");
  console.log(JSON.stringify(graph, null, 2));
}

main().catch(console.error);
