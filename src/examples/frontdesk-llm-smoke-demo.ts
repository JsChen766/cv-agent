import { fileURLToPath } from "node:url";
import { FrontDeskAgent, FrontDeskIntentSchema } from "../agents/FrontDeskAgent.js";
import { AgentProviderFactory } from "../providers/factory/index.js";

export async function runFrontDeskLlmSmokeDemo(): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      skipped: true,
      reason: "Set DEEPSEEK_API_KEY to run FrontDesk LLM smoke demo.",
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
  const agent = new FrontDeskAgent({
    modelClient: agentProvider.modelClient,
  });

  const decision = await agent.decide({
    userId: "smoke-user",
    message: "I uploaded my resume. Please import and analyze it.",
    hasDocument: true,
    documentFileNames: ["resume.md"],
  });
  FrontDeskIntentSchema.parse(decision.intent);

  return {
    skipped: false,
    provider: agentProvider.providerName,
    model: agentProvider.model,
    decision,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runFrontDeskLlmSmokeDemo(), null, 2));
}
