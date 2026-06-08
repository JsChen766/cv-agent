import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentName } from "../validation/AgentOutputSchemas.js";

const AGENT_PROMPT_FILES: Record<AgentName, string> = {
  frontdesk: "frontdesk.md",
  experience_receiver: "experience-receiver.md",
  strategist: "strategist.md",
  architect: "architect.md",
  critic: "critic.md",
};

const PRODUCT_PROMPT_FILES = {
  "product.experienceExtraction.system": "product/experience-extraction-system.md",
  "product.experienceExtraction.repair": "product/experience-extraction-repair.md",
  "product.rewrite.experienceSystem": "product/rewrite-experience-system.md",
  "product.rewrite.resumeItemSystem": "product/rewrite-resume-item-system.md",
  "product.rewrite.claimCheckSystem": "product/rewrite-claim-check-system.md",
  "product.generation.resumeSystem": "product/generation-resume-system.md",
  "product.generation.resumeRepair": "product/generation-resume-repair.md",
  "product.evidence.jdRequirementSystem": "product/evidence-jd-requirement-system.md",
  "product.evidence.claimExtractionSystem": "product/evidence-claim-extraction-system.md",
  "tools.resume.prepareReviseResumeItem.system": "tools/resume/prepare-revise-resume-item-system.md",
  "tools.experience.jdMatch.system": "tools/experience/jd-match-system.md",
} as const;

export type ProductPromptName = keyof typeof PRODUCT_PROMPT_FILES;
export type PromptName = AgentName | ProductPromptName;

const PROMPT_FILES: Record<PromptName, string> = {
  ...AGENT_PROMPT_FILES,
  ...PRODUCT_PROMPT_FILES,
};

export class PromptRegistry {
  private readonly cache = new Map<PromptName, string>();
  private readonly root: string;

  public constructor(root = join(dirname(fileURLToPath(import.meta.url)), "prompts")) {
    this.root = root;
  }

  public get(promptName: AgentName): string;
  public get(promptName: ProductPromptName): string;
  public get(promptName: PromptName): string {
    const cached = this.cache.get(promptName);
    if (cached) return cached;
    const file = PROMPT_FILES[promptName];
    if (!file) throw new Error(`Prompt not registered: ${String(promptName)}`);
    const rawPrompt = readFileSync(join(this.root, file), "utf8");
    const prompt = isProductPromptName(promptName) ? trimOneFinalNewline(rawPrompt) : rawPrompt;
    this.cache.set(promptName, prompt);
    return prompt;
  }
}

function isProductPromptName(value: PromptName): value is ProductPromptName {
  return Object.prototype.hasOwnProperty.call(PRODUCT_PROMPT_FILES, value);
}

function trimOneFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}
