import type { CopilotChatRequest } from "./types.js";

export type CopilotLocale = "zh-CN" | "en";

export function detectLocale(message: string, clientState?: CopilotChatRequest["clientState"]): CopilotLocale {
  if (clientState?.locale === "zh-CN" || clientState?.locale?.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  const cjkMatches = message.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinMatches = message.match(/[a-z]/gi)?.length ?? 0;
  return cjkMatches > 0 && cjkMatches >= latinMatches ? "zh-CN" : "en";
}
