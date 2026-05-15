import { fileURLToPath } from "node:url";
import { LLMArtifactCritic } from "../application/critique/LLMArtifactCritic.js";
import type { ArtifactCoverageReport } from "../application/evaluation/types.js";
import { AgentProviderFactory } from "../providers/factory/index.js";
import type {
  Evidence,
  EvidenceChain,
  Experience,
  GeneratedArtifact,
  JDRequirement,
} from "../knowledge/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

export async function runCriticLlmSmokeDemo(): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      skipped: true,
      reason: "Set DEEPSEEK_API_KEY to run Critic LLM smoke demo.",
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
  const critic = new LLMArtifactCritic({
    modelClient: agentProvider.modelClient,
    allowFallbackToDeterministic: false,
  });

  const artifacts = [
    makeArtifact({
      id: "artifact-ready",
      content: "Built 50+ Power BI dashboards for sales stakeholders.",
      enhancementStatus: "ready",
      supportLevel: "supported",
      riskLevel: "low",
    }),
    makeArtifact({
      id: "artifact-confirm",
      content: "Improved stakeholder reporting adoption by 35%.",
      enhancementStatus: "needs_confirmation",
      supportLevel: "needs_user_confirmation",
      riskLevel: "medium",
      confirmationQuestions: ["Can you confirm the 35% adoption improvement?"],
    }),
    makeArtifact({
      id: "artifact-unsafe",
      content: "Owned company-wide analytics strategy.",
      enhancementStatus: "unsafe",
      supportLevel: "unsupported",
      riskLevel: "high",
    }),
  ];
  const evidenceChains = artifacts.map((artifact) => makeEvidenceChain(artifact));
  const coverageReport = makeCoverageReport();
  const report = await critic.critique({
    userId: "smoke-user",
    jdId: "jd-smoke",
    artifacts,
    evidenceChains,
    coverageReport,
  });

  return {
    skipped: false,
    provider: agentProvider.providerName,
    model: agentProvider.model,
    summary: report.summary,
    items: report.items.map((item) => ({
      artifactId: item.artifactId,
      verdict: item.verdict,
      truthfulnessRisk: item.truthfulnessRisk,
      exaggerationRisk: item.exaggerationRisk,
      rewriteSuggestions: item.rewriteSuggestions,
      confirmationQuestions: item.confirmationQuestions ?? [],
    })),
  };
}

function makeArtifact(input: {
  id: string;
  content: string;
  enhancementStatus: "ready" | "needs_confirmation" | "unsafe";
  supportLevel: "supported" | "needs_user_confirmation" | "unsupported";
  riskLevel: "low" | "medium" | "high";
  confirmationQuestions?: string[];
}): GeneratedArtifact {
  return {
    id: input.id,
    userId: "smoke-user",
    type: "resume_bullet",
    content: input.content,
    sourceExperienceIds: ["exp-smoke"],
    sourceEvidenceIds: ["ev-dashboard", "ev-report"],
    matchedSkillIds: ["skill-power-bi"],
    targetJDId: "jd-smoke",
    targetRequirementIds: ["req-bi"],
    targetRole: "BI Analyst",
    scores: {
      overall: input.enhancementStatus === "ready" ? 0.82 : 0.55,
      requirementMatch: 0.8,
      evidenceStrength: 0.85,
    },
    status: input.enhancementStatus === "ready" ? "ready" : "needs_review",
    metadata: {
      enhancement: {
        status: input.enhancementStatus,
        claims: [{
          text: input.content,
          supportLevel: input.supportLevel,
          riskLevel: input.riskLevel,
          evidenceIds: input.supportLevel === "supported" ? ["ev-dashboard"] : [],
          sourceExperienceIds: ["exp-smoke"],
          ...(input.supportLevel === "needs_user_confirmation"
            ? { userConfirmationPrompt: input.confirmationQuestions?.[0] ?? "Please confirm the metric." }
            : {}),
        }],
        confirmationQuestions: input.confirmationQuestions ?? [],
        enhancementStrategy: input.enhancementStatus === "ready"
          ? "evidence_rewrite"
          : input.enhancementStatus === "unsafe"
            ? "unsafe_candidate"
            : "confirmation_needed",
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeEvidenceChain(artifact: GeneratedArtifact): EvidenceChain {
  const experience: Experience = {
    id: "exp-smoke",
    userId: "smoke-user",
    type: "work",
    organization: "Example Analytics",
    role: "BI Developer",
    summary: "Built dashboards and reporting automation.",
    timeRange: { startDate: null, endDate: null },
    star: {
      situation: "Manual reporting",
      task: "Improve reporting",
      action: "Built dashboards",
      result: "Reduced reporting time",
    },
    evidenceIds: ["ev-dashboard", "ev-report"],
    skillIds: ["skill-power-bi"],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const evidences: Evidence[] = [
    {
      id: "ev-dashboard",
      userId: "smoke-user",
      experienceId: "exp-smoke",
      sourceType: "manual",
      evidenceType: "project",
      sourceRef: "smoke:critic",
      excerpt: "Built 50+ Power BI dashboards for sales stakeholders.",
      confidence: 0.92,
      createdAt: NOW,
    },
    {
      id: "ev-report",
      userId: "smoke-user",
      experienceId: "exp-smoke",
      sourceType: "manual",
      evidenceType: "result",
      sourceRef: "smoke:critic",
      excerpt: "Reduced report preparation time from 2 hours to 20 minutes.",
      confidence: 0.94,
      createdAt: NOW,
    },
  ];
  return {
    id: `chain-${artifact.id}`,
    artifact,
    summary: "Evidence chain for smoke artifact.",
    requirementMatches: [],
    sourceExperiences: [experience],
    sourceEvidences: evidences,
    sourceSkills: [],
    risk: {
      level: artifact.metadata?.enhancement && readEnhancementStatus(artifact) === "ready" ? "low" : "high",
      truthfulnessRisk: readEnhancementStatus(artifact) === "ready" ? "low" : "high",
      exaggerationRisk: readEnhancementStatus(artifact) === "ready" ? "low" : "high",
      missingEvidenceClaims: readEnhancementStatus(artifact) === "needs_confirmation" ? ["Confirm proposed metric."] : [],
      exaggerationWarnings: readEnhancementStatus(artifact) === "unsafe" ? ["Unsupported broad ownership claim."] : [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: NOW,
  };
}

function makeCoverageReport(): ArtifactCoverageReport {
  const requirement: JDRequirement = {
    id: "req-bi",
    userId: "smoke-user",
    jdId: "jd-smoke",
    description: "BI dashboard and stakeholder reporting",
    requiredSkillIds: ["skill-power-bi"],
    weight: 1,
    createdAt: NOW,
  };
  return {
    id: "coverage-smoke",
    userId: "smoke-user",
    jdId: "jd-smoke",
    totalRequirements: 1,
    coveredRequirementIds: ["req-bi"],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: [],
    noEvidenceRequirementIds: [],
    notTargetedRequirementIds: [],
    items: [{
      requirement,
      status: "covered",
      coveredByArtifactIds: ["artifact-ready"],
      supportingEvidenceIds: ["ev-dashboard"],
      supportingSkillIds: ["skill-power-bi"],
      reason: "Dashboard evidence is available.",
      suggestions: [],
    }],
    summary: "1/1 requirements covered.",
    createdAt: NOW,
  };
}

function readEnhancementStatus(artifact: GeneratedArtifact): string {
  const enhancement = artifact.metadata?.enhancement;
  if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
    return "unknown";
  }
  const status = (enhancement as Record<string, unknown>).status;
  return typeof status === "string" ? status : "unknown";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runCriticLlmSmokeDemo(), null, 2));
}
