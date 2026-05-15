import { fileURLToPath } from "node:url";
import { AgentProviderFactory } from "../providers/factory/index.js";
import { LLMExperienceExtractor } from "../knowledge/ingestion/LLMExperienceExtractor.js";

export async function runExperienceExtractorLlmSmokeDemo(): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      skipped: true,
      reason: "Set DEEPSEEK_API_KEY to run Experience Extractor LLM smoke demo.",
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
  const extractor = new LLMExperienceExtractor({
    modelClient: agentProvider.modelClient,
    allowFallbackToDeterministic: false,
  });

  const extraction = await extractor.extract({
    userId: "smoke-user",
    rawText: [
      "Built a React dashboard for internal analytics using TypeScript, improving product manager visibility into weekly adoption metrics.",
      "Automated PostgreSQL reporting workflows that reduced report preparation time from 2 hours to 20 minutes.",
    ].join("\n"),
    sourceRef: "smoke:experience",
    sourceType: "manual",
  });
  const skillNames = Array.from(new Set(
    extraction.experiences.flatMap((experience) =>
      (experience.skillNames ?? []).map((skill) => skill.name),
    ),
  ));

  return {
    skipped: false,
    provider: agentProvider.providerName,
    model: agentProvider.model,
    experienceCount: extraction.experiences.length,
    experiences: extraction.experiences.map((experience) => ({
      type: experience.type,
      organization: experience.organization,
      role: experience.role,
      summary: experience.summary,
      evidenceCount: experience.evidenceExcerpts.length,
    })),
    evidenceCount: extraction.experiences.reduce(
      (count, experience) => count + experience.evidenceExcerpts.length,
      0,
    ),
    skills: skillNames,
    warnings: extraction.warnings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runExperienceExtractorLlmSmokeDemo(), null, 2));
}
