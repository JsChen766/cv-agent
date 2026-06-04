import { AgentError } from "../runtime/AgentError.js";
import { parseJsonOutput } from "../../infrastructure/llm/JsonOutputParser.js";

export function parseAgentJson(text: string): unknown {
  try {
    return parseJsonOutput(text);
  } catch (error) {
    throw new AgentError("INVALID_AGENT_OUTPUT", "Agent returned invalid JSON.", { cause: error });
  }
}
