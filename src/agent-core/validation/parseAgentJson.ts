import { AgentError } from "../runtime/AgentError.js";

export function parseAgentJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = extractJsonCandidate(trimmed);
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new AgentError("INVALID_AGENT_OUTPUT", "Agent returned invalid JSON.", { cause: error });
  }
}

function extractJsonCandidate(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text;
}
