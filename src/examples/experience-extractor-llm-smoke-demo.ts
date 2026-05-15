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

  const extracted = await extractor.extract({
    userId: "smoke-user",
    rawText: "Built a React dashboard for internal analytics, reduced report preparation time from 2 hours to 20 minutes, and used TypeScript and PostgreSQL.",
    sourceRef: "smoke:experience",
    sourceType: "manual",
  });

  return {
    skipped: false,
    provider: agentProvider.providerName,
    model: agentProvider.model,
    experience: {
      type: extracted.type,
      organization: extracted.organization,
      role: extracted.role,
      summary: extracted.summary,
      evidenceCount: extracted.evidenceExcerpts.length,
      skills: extracted.skillNames?.map((skill) => skill.name) ?? [],
      warnings: extracted.warnings ?? [],
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runExperienceExtractorLlmSmokeDemo(), null, 2));
}
