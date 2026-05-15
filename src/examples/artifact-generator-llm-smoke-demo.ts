import { fileURLToPath } from "node:url";
import { AgentProviderFactory } from "../providers/factory/index.js";
import { LLMArtifactGenerator } from "../application/generators/LLMArtifactGenerator.js";
import type { Evidence, Experience, JDRequirement, Skill } from "../knowledge/types.js";
import type { RetrievedExperience } from "../knowledge/retrieval/ExperienceRetriever.js";

export async function runArtifactGeneratorLlmSmokeDemo(): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      skipped: true,
      reason: "Set DEEPSEEK_API_KEY to run Artifact Generator LLM smoke demo.",
    };
  }

  const agentProvider = AgentProviderFactory.create({
    provider: "deepseek",
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    allowMockFallback: false,
    maxRetries: 0,
    timeoutMs: 30_000,
  });
  const generator = new LLMArtifactGenerator({
    modelClient: agentProvider.modelClient,
    allowFallbackToDeterministic: false,
  });

  const experience: Experience = {
    id: "exp-smoke-bi",
    userId: "smoke-user",
    type: "work",
    organization: "Example Analytics",
    role: "BI Developer",
    summary: "Built BI dashboards and reporting automation.",
    timeRange: { startDate: null, endDate: null },
    star: {
      situation: "Manual reporting workflows slowed stakeholder decisions.",
      task: "Improve reporting visibility and speed.",
      action: "Built dashboards and automated reports.",
      result: "Reduced report preparation time.",
    },
    evidenceIds: ["ev-dashboard", "ev-report"],
    skillIds: ["skill-power-bi", "skill-sql", "skill-stakeholders"],
    confidence: 0.9,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const evidences: Evidence[] = [
    {
      id: "ev-dashboard",
      userId: "smoke-user",
      experienceId: experience.id,
      sourceType: "manual",
      evidenceType: "project",
      sourceRef: "smoke:artifact",
      excerpt: "Built 50+ Power BI dashboards for sales stakeholders.",
      confidence: 0.92,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "ev-report",
      userId: "smoke-user",
      experienceId: experience.id,
      sourceType: "manual",
      evidenceType: "result",
      sourceRef: "smoke:artifact",
      excerpt: "Reduced report preparation time from 2 hours to 20 minutes.",
      confidence: 0.94,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const skills: Skill[] = [
    {
      id: "skill-power-bi",
      userId: "smoke-user",
      name: "Power BI",
      category: "technical",
      evidenceIds: ["ev-dashboard"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "skill-sql",
      userId: "smoke-user",
      name: "SQL",
      category: "technical",
      evidenceIds: ["ev-report"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "skill-stakeholders",
      userId: "smoke-user",
      name: "Stakeholder Communication",
      category: "soft",
      evidenceIds: ["ev-dashboard"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const requirements: JDRequirement[] = [
    {
      id: "req-bi",
      userId: "smoke-user",
      jdId: "jd-smoke",
      description: "BI dashboard development",
      requiredSkillIds: ["skill-power-bi"],
      weight: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "req-sql",
      userId: "smoke-user",
      jdId: "jd-smoke",
      description: "SQL reporting automation",
      requiredSkillIds: ["skill-sql"],
      weight: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "req-stakeholder",
      userId: "smoke-user",
      jdId: "jd-smoke",
      description: "Stakeholder communication",
      requiredSkillIds: ["skill-stakeholders"],
      weight: 0.8,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const retrievedExperience: RetrievedExperience = {
    experience,
    evidences,
    skills,
    matchedEvidences: evidences,
    matchedSkills: skills,
    matchedRequirements: requirements,
    matchScore: 0.9,
    matchedRequirementIds: requirements.map((requirement) => requirement.id),
    matchedEvidenceIds: evidences.map((evidence) => evidence.id),
    matchedSkillIds: skills.map((skill) => skill.id),
    reason: "Smoke evidence matches BI, SQL, and stakeholder requirements.",
  };

  const result = await generator.generate({
    userId: "smoke-user",
    jdId: "jd-smoke",
    jdText: "Need BI dashboard, SQL reporting automation, and stakeholder communication experience.",
    targetRole: "BI Analyst",
    requirements,
    experiences: [experience],
    evidences,
    skills,
    retrievedExperiences: [retrievedExperience],
  });

  return {
    skipped: false,
    provider: agentProvider.providerName,
    model: agentProvider.model,
    artifactCount: result.artifacts.length,
    artifacts: result.artifacts.map((artifact) => {
      const enhancement = artifact.metadata?.enhancement;
      const metadata = typeof enhancement === "object" && enhancement !== null && !Array.isArray(enhancement)
        ? enhancement as {
            status?: unknown;
            claims?: Array<{ supportLevel?: unknown }>;
            confirmationQuestions?: unknown;
          }
        : {};
      return {
        content: artifact.content,
        status: metadata.status,
        claimSupportLevels: metadata.claims?.map((claim) => claim.supportLevel) ?? [],
        confirmationQuestions: metadata.confirmationQuestions ?? [],
      };
    }),
    warnings: result.warnings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runArtifactGeneratorLlmSmokeDemo(), null, 2));
}
