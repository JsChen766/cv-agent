import type { ModelClient } from "../../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../../agent-core/prompts/PromptRegistry.js";
import { extractJsonCandidates } from "../../infrastructure/llm/JsonOutputParser.js";
import type { JDRequirement, ExperienceClaim } from "./types.js";

const PROMPTS = new PromptRegistry();

export class LLMEvidenceService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async parseJDRequirements(input: { jdText: string; targetRole?: string }): Promise<Partial<JDRequirement>[]> {
    const response = await this.modelClient.chat({
      messages: [
        { role: "system", content: PROMPTS.get("product.evidence.jdRequirementSystem") },
        { role: "user", content: [`Target role: ${input.targetRole ?? "unknown"}`, "", input.jdText.slice(0, 5000)].join("\n") },
      ],
      temperature: 0.1,
      maxTokens: 4096,
      responseFormat: "json",
    });
    const parsed = parseFirstJson(response.content);
    if (isRecord(parsed) && Array.isArray(parsed.requirements)) {
      return parsed.requirements.filter(isRecord).map((item) => ({
        text: stringField(item.text),
        category: stringField(item.category) as JDRequirement["category"],
        importance: stringField(item.importance) as JDRequirement["importance"],
        evidenceType: stringField(item.evidenceType) as JDRequirement["evidenceType"],
      }));
    }
    return [];
  }

  public async extractClaims(input: {
    experienceId: string;
    revisionId?: string;
    title: string;
    content: string;
  }): Promise<Partial<ExperienceClaim>[]> {
    const response = await this.modelClient.chat({
      messages: [
        { role: "system", content: PROMPTS.get("product.evidence.claimExtractionSystem") },
        { role: "user", content: [`Experience: [${input.experienceId}] ${input.title}`, "", input.content.slice(0, 3500)].join("\n") },
      ],
      temperature: 0.1,
      maxTokens: 4096,
      responseFormat: "json",
    });
    const parsed = parseFirstJson(response.content);
    if (isRecord(parsed) && Array.isArray(parsed.claims)) {
      return parsed.claims.filter(isRecord).map((item, index) => ({
        id: stringField(item.id) || `claim-${input.experienceId}-${index + 1}`,
        experienceId: input.experienceId,
        revisionId: input.revisionId,
        claim: stringField(item.claim),
        evidenceText: stringField(item.evidenceText),
        skills: Array.isArray(item.skills) ? item.skills.filter((value): value is string => typeof value === "string") : [],
        confidence: numberField(item.confidence, 0.6),
        riskLevel: stringField(item.riskLevel) as ExperienceClaim["riskLevel"],
      }));
    }
    return [];
  }
}

function parseFirstJson(content: string): unknown {
  const candidates = extractJsonCandidates(content).map((candidate) => candidate.text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return fallback;
}
