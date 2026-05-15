import { fileURLToPath } from "node:url";
import { AgentProviderFactory } from "../providers/factory/index.js";
import { LLMArtifactRevisionAgent } from "../application/revision/index.js";
import type { ArtifactRevisionInput } from "../application/revision/index.js";
import type { Evidence, EvidenceChain, Experience, GeneratedArtifact } from "../knowledge/types.js";

export async function runRevisionLlmSmokeDemo(): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      skipped: true,
      reason: "Set DEEPSEEK_API_KEY to run Revision LLM smoke demo.",
    };
  }

  const provider = AgentProviderFactory.create({
    provider: "deepseek",
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    allowMockFallback: false,
    maxRetries: 0,
    timeoutMs: 30_000,
  });
  const agent = new LLMArtifactRevisionAgent({
    modelClient: provider.modelClient,
  });
  const input = makeInput();
  const result = await agent.revise(input);
  return {
    content: result.revisedArtifact.content,
    status: result.revisedArtifact.metadata?.enhancement,
    claims: readClaims(result.revisedArtifact),
    confirmationQuestions: readConfirmationQuestions(result.revisedArtifact),
    warnings: result.warnings,
  };
}

function makeInput(): ArtifactRevisionInput {
  const now = new Date().toISOString();
  const experience: Experience = {
    id: "exp-reporting",
    userId: "smoke-user",
    type: "project",
    organization: "Demo Analytics",
    role: "BI Analyst",
    summary: "Built reporting dashboards.",
    timeRange: {
      startDate: "2024-01",
      endDate: "2024-06",
    },
    star: {
      situation: "Reporting workflow needed dashboards.",
      task: "Build dashboards.",
      action: "Built reporting dashboards.",
      result: "Dashboards delivered.",
    },
    evidenceIds: ["ev-reporting"],
    skillIds: [],
    confidence: 0.9,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
  const evidence: Evidence = {
    id: "ev-reporting",
    userId: "smoke-user",
    experienceId: experience.id,
    excerpt: "Built reporting dashboards.",
    sourceType: "manual",
    evidenceType: "project",
    sourceRef: "smoke",
    confidence: 0.9,
    metadata: {},
    createdAt: now,
  };
  const artifact: GeneratedArtifact = {
    id: "artifact-reporting",
    userId: "smoke-user",
    type: "resume_bullet",
    content: "Improved reporting accuracy by 35%.",
    sourceExperienceIds: [experience.id],
    sourceEvidenceIds: [evidence.id],
    matchedSkillIds: [],
    targetJDId: "jd-bi",
    targetRequirementIds: ["req-reporting"],
    targetRole: "BI Analyst",
    scores: {
      overall: 0.5,
      requirementMatch: 0.5,
      evidenceStrength: 0.5,
    },
    status: "needs_review",
    metadata: {
      enhancement: {
        status: "needs_confirmation",
        claims: [{
          text: "Improved reporting accuracy by 35%.",
          supportLevel: "needs_user_confirmation",
          riskLevel: "medium",
          evidenceIds: [],
          sourceExperienceIds: [],
          userConfirmationPrompt: "Can you confirm the 35% accuracy improvement?",
        }],
        confirmationQuestions: ["Can you confirm the 35% accuracy improvement?"],
        enhancementStrategy: "confirmation_needed",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
  const evidenceChain: EvidenceChain = {
    id: "chain-reporting",
    artifact,
    summary: "One reporting dashboard evidence item.",
    requirementMatches: [],
    sourceExperiences: [experience],
    sourceEvidences: [evidence],
    sourceSkills: [],
    risk: {
      level: "medium",
      truthfulnessRisk: "medium",
      exaggerationRisk: "medium",
      missingEvidenceClaims: ["35% is not supported by evidence."],
      exaggerationWarnings: [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: now,
  };
  return {
    userId: "smoke-user",
    jdId: "jd-bi",
    artifact,
    critiqueItem: {
      artifactId: artifact.id,
      verdict: "revise",
      truthfulnessRisk: "medium",
      exaggerationRisk: "medium",
      specificityScore: 0.8,
      evidenceStrengthScore: 0.4,
      unsupportedClaims: [],
      missingEvidence: ["35% is not supported by evidence."],
      rewriteSuggestions: ["Rewrite without the 35% metric unless confirmed."],
      confirmationQuestions: ["Can you confirm the 35% accuracy improvement?"],
    },
    evidenceChain,
    instruction: "make_more_conservative",
  };
}

function readClaims(artifact: GeneratedArtifact): unknown {
  const enhancement = artifact.metadata?.enhancement;
  if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
    return [];
  }
  const claims = (enhancement as Record<string, unknown>).claims;
  return Array.isArray(claims)
    ? claims.map((claim) => {
      if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
        return claim;
      }
      const record = claim as Record<string, unknown>;
      return {
        text: record.text,
        supportLevel: record.supportLevel,
        riskLevel: record.riskLevel,
      };
    })
    : [];
}

function readConfirmationQuestions(artifact: GeneratedArtifact): unknown {
  const enhancement = artifact.metadata?.enhancement;
  if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
    return [];
  }
  const questions = (enhancement as Record<string, unknown>).confirmationQuestions;
  return Array.isArray(questions) ? questions : [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runRevisionLlmSmokeDemo(), null, 2));
}
