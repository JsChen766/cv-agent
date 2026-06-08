import type { EvidenceRAGExperience, ExperienceClaim } from "./types.js";
import { clamp, extractKeywords, safeSlice, splitSentences, stringifyStructured, unique } from "./textUtils.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";

export class ExperienceClaimExtractor {
  public constructor(private readonly llmEvidenceService?: LLMEvidenceService) {}

  public async extract(experience: EvidenceRAGExperience): Promise<ExperienceClaim[]> {
    const deterministic = this.extractDeterministic(experience);
    if (!this.llmEvidenceService || !experience.content?.trim()) return deterministic;
    try {
      const llmClaims = await this.llmEvidenceService.extractClaims({
        experienceId: experience.id,
        revisionId: experience.currentRevisionId,
        title: experience.title,
        content: [experience.content, stringifyStructured(experience.structured)].filter(Boolean).join("\n"),
      });
      const normalized = llmClaims.map((claim, index) => normalizeLLMClaim(claim, experience, index)).filter((claim): claim is ExperienceClaim => Boolean(claim));
      return mergeClaims([...normalized, ...deterministic]).slice(0, 12);
    } catch {
      return deterministic;
    }
  }

  private extractDeterministic(experience: EvidenceRAGExperience): ExperienceClaim[] {
    const structured = experience.structured ?? {};
    const textItems = [
      ...arrayOfStrings(structured.highlights),
      ...metricsToStrings(structured.metrics),
      ...arrayOfStrings(structured.honors),
      ...arrayOfStrings(structured.evidence),
      ...splitSentences(experience.content, 8),
    ].filter((item) => item.trim().length > 0);

    const claims = mergeClaims(textItems.map((text, index): ExperienceClaim => ({
      id: `claim-${experience.id}-${index + 1}`,
      experienceId: experience.id,
      revisionId: experience.currentRevisionId,
      claim: safeSlice(text, 220),
      evidenceText: safeSlice(text, 320),
      skills: inferSkills(text, structured),
      confidence: confidenceForText(text, structured),
      riskLevel: riskForText(text),
    })));

    if (claims.length > 0) return claims.slice(0, 10);

    const fallback = [experience.title, experience.role, experience.organization, experience.content].filter(Boolean).join(" ");
    return [{
      id: `claim-${experience.id}-1`,
      experienceId: experience.id,
      revisionId: experience.currentRevisionId,
      claim: safeSlice(fallback || experience.title, 220),
      evidenceText: safeSlice(experience.content || fallback || experience.title, 320),
      skills: inferSkills(fallback, structured),
      confidence: experience.content ? 0.5 : 0.35,
      riskLevel: "medium",
    }];
  }
}

function normalizeLLMClaim(raw: Partial<ExperienceClaim>, experience: EvidenceRAGExperience, index: number): ExperienceClaim | null {
  const claim = raw.claim?.trim();
  if (!claim) return null;
  const evidenceText = raw.evidenceText?.trim() || claim;
  const riskLevel = raw.riskLevel === "low" || raw.riskLevel === "medium" || raw.riskLevel === "high" ? raw.riskLevel : riskForText(claim);
  return {
    id: raw.id?.trim() || `claim-${experience.id}-llm-${index + 1}`,
    experienceId: experience.id,
    revisionId: experience.currentRevisionId,
    claim: safeSlice(claim, 220),
    evidenceText: safeSlice(evidenceText, 320),
    skills: unique([...(raw.skills ?? []), ...inferSkills(claim, experience.structured ?? {})]).slice(0, 10),
    confidence: clamp(raw.confidence ?? 0.65),
    riskLevel,
  };
}

function mergeClaims(claims: ExperienceClaim[]): ExperienceClaim[] {
  const seen = new Set<string>();
  const result: ExperienceClaim[] = [];
  for (const claim of claims) {
    const key = claim.claim.toLowerCase().replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(claim);
  }
  return result;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).filter(Boolean);
}

function metricsToStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      return [record.name, record.value, record.context].filter((part) => typeof part === "string" && part.trim()).join(" ");
    }
    return "";
  }).filter(Boolean);
}

function inferSkills(text: string, structured: Record<string, unknown>): string[] {
  const structuredSkills = [
    ...arrayOfStrings(structured.skills),
    ...arrayOfStrings(structured.techStack),
    ...arrayOfStrings(structured.courses),
  ];
  const keywords = extractKeywords(text, 12).filter((keyword) => /^(python|java|javascript|typescript|react|vue|sql|excel|tableau|pytorch|tensorflow|llm|rag|agent|api|figma|research|analysis|调研|分析|沟通|协作)$/i.test(keyword));
  return unique([...structuredSkills, ...keywords]).slice(0, 12);
}

function confidenceForText(text: string, structured: Record<string, unknown>): number {
  let score = 0.5;
  if (/\d|%|％/.test(text)) score += 0.15;
  if (Object.keys(structured).length > 0) score += 0.1;
  if (text.length > 40) score += 0.1;
  return clamp(score);
}

function riskForText(text: string): ExperienceClaim["riskLevel"] {
  if (/\b(led|owned|drove|managed|increased|improved|reduced)\b/i.test(text) || /主导|提升|增长|降低|管理/.test(text)) return "medium";
  if (/\d|%|％/.test(text)) return "low";
  return "low";
}
