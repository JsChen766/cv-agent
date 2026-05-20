import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentName } from "../validation/AgentOutputSchemas.js";

const PROMPT_FILES: Record<AgentName, string> = {
  frontdesk: "frontdesk.md",
  experience_receiver: "experience-receiver.md",
  strategist: "strategist.md",
  architect: "architect.md",
  critic: "critic.md",
};

export class PromptRegistry {
  private readonly cache = new Map<AgentName, string>();
  private readonly root: string;

  public constructor(root = join(dirname(fileURLToPath(import.meta.url)), "prompts")) {
    this.root = root;
  }

  public get(agentName: AgentName): string {
    const cached = this.cache.get(agentName);
    if (cached) return cached;
    const prompt = readFileSync(join(this.root, PROMPT_FILES[agentName]), "utf8");
    this.cache.set(agentName, prompt);
    return prompt;
  }
}
