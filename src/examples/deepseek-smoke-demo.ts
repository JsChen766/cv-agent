import { fileURLToPath } from "node:url";
import { AgentProviderFactory } from "../providers/factory/index.js";

export async function runDeepSeekSmokeDemo(): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      skipped: true,
      reason: "Set DEEPSEEK_API_KEY to run DeepSeek smoke demo.",
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
  const { modelClient } = agentProvider;

  const textResponse = await modelClient.chat({
    messages: [
      {
        role: "user",
        content: "Reply with exactly: cv-agent smoke ok",
      },
    ],
    maxTokens: 20,
    temperature: 0,
  });

  const jsonResponse = await modelClient.chat({
    messages: [
      {
        role: "user",
        content: "Return JSON only: {\"ok\":true,\"name\":\"cv-agent\"}",
      },
    ],
    responseFormat: "json",
    maxTokens: 40,
    temperature: 0,
  });

  return {
    skipped: false,
    provider: modelClient.getProviderName(),
    text: textResponse.content,
    json: jsonResponse.content,
    reasoningPresent: Boolean(textResponse.reasoning || jsonResponse.reasoning),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runDeepSeekSmokeDemo(), null, 2));
}
