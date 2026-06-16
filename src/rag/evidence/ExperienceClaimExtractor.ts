import type { EvidenceRAGExperience, ExperienceClaim } from "./types.js";
import {
  clamp,
  extractKeywords,
  extractNumbers,
  normalizeText,
  safeSlice,
  scoreTextOverlap,
  splitSentences,
  stringifyStructured,
  unique,
} from "./textUtils.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";

const OWNERSHIP_TERMS = ["led", "owned", "drove", "managed", "launched", "主导", "牵头", "负责", "管理", "上线"];
const IMPACT_TERMS = ["improved", "increased", "reduced", "grew", "提升", "增长", "降低", "优化"];

export class ExperienceClaimExtractor {
  public constructor(private readonly llmEvidenceService?: LLMEvidenceService) {}

  public async extract(experience: EvidenceRAGExperience): Promise<ExperienceClaim[]> {
    const deterministic = this.extractDeterministic(experience);
    if (!this.llmEvidenceService || !experience.content?.trim()) return deterministic;

    try {
      const source = [
        experience.title,
        experience.role,
        experience.organization,
        experience.content,
        stringifyStructured(experience.structured),
      ].filter(Boolean).join("\n");
      const llmClaims = await this.llmEvidenceService.extractClaims({
        experienceId: experience.id,
        revisionId: experience.currentRevisionId,
        title: experience.title,
        content: source,
      });
      const normalized = llmClaims
        .map((claim, index) => normalizeAndValidateLLMClaim(claim, experience, source, index))
        .filter((claim): claim is ExperienceClaim => Boolean(claim));
      return mergeClaims([...normalized, ...deterministic]).slice(0, 16);
    } catch (error) {
      if (process.env.DEBUG_EVIDENCE_RAG === "true") {
        console.warn("[ExperienceClaimExtractor] LLM claim extraction failed; using deterministic claims", error);
      }
      return deterministic;
    }
  }

  private extractDeterministic(experience: EvidenceRAGExperience): ExperienceClaim[] {
    const structured = experience.structured ?? {};
    const textItems = unique([
      ...arrayOfStrings(structured.highlights),
      ...metricsToStrings(structured.metrics),
      ...arrayOfStrings(structured.honors),
      ...arrayOfStrings(structured.evidence),
      ...arrayOfStrings(structured.responsibilities),
      ...arrayOfStrings(structured.achievements),
      ...splitSentences(experience.content, 14),
    ]).filter((item) => item.trim().length > 0);

    const claims = mergeClaims(textItems.map((text, index): ExperienceClaim => ({
      id: `claim-${experience.id}-${index + 1}`,
      experienceId: experience.id,
      revisionId: experience.currentRevisionId,
      claim: safeSlice(text, 220),
      evidenceText: safeSlice(text, 360),
      skills: inferSkills(text, structured),
      confidence: confidenceForText(text, structured),
      riskLevel: riskForText(text, text),
    })));

    if (claims.length > 0) return claims.slice(0, 14);

    const fallback = [experience.title, experience.role, experience.organization, experience.content].filter(Boolean).join(" ");
    return [{
      id: `claim-${experience.id}-1`,
      experienceId: experience.id,
      revisionId: experience.currentRevisionId,
      claim: safeSlice(fallback || experience.title, 220),
      evidenceText: safeSlice(experience.content || fallback || experience.title, 360),
      skills: inferSkills(fallback, structured),
      confidence: experience.content?.trim() ? 0.5 : 0.35,
      riskLevel: "medium",
    }];
  }
}

function normalizeAndValidateLLMClaim(
  raw: Partial<ExperienceClaim>,
  experience: EvidenceRAGExperience,
  source: string,
  index: number,
): ExperienceClaim | null {
  const claimText = safeSlice(raw.claim, 220);
  if (!claimText || claimText.length < 3) return null;

  const supportingEvidence = selectSupportingEvidence(raw.evidenceText, claimText, source);
  if (!supportingEvidence) return null;

  const sourceNumbers = new Set(extractNumbers(source));
  const claimNumbers = extractNumbers(claimText);
  const unsupportedNumbers = claimNumbers.filter((number) => !sourceNumbers.has(number));
  if (unsupportedNumbers.length > 0) return null;

  const sourceNormalized = normalizeText(source);
  const ownershipUnsupported = OWNERSHIP_TERMS.some((term) => normalizeText(claimText).includes(normalizeText(term)))
    && !OWNERSHIP_TERMS.some((term) => sourceNormalized.includes(normalizeText(term)));
  if (ownershipUnsupported) return null;

  const overlap = scoreTextOverlap(extractKeywords(claimText, 18), supportingEvidence);
  if (overlap.score < 0.12 && !normalizeText(source).includes(normalizeText(claimText))) return null;

  const inferredRisk = riskForText(claimText, source);
  const riskLevel = normalizeRisk(raw.riskLevel, inferredRisk);
  const confidence = clamp((typeof raw.confidence === "number" ? raw.confidence : 0.68) * 0.7 + overlap.score * 0.3);
  if (confidence < 0.35) return null;

  return {
    id: raw.id?.trim() || `claim-${experience.id}-llm-${index + 1}`,
    experienceId: experience.id,
    revisionId: experience.currentRevisionId,
    claim: claimText,
    evidenceText: safeSlice(supportingEvidence, 360),
    skills: unique([...(raw.skills ?? []), ...inferSkills(`${claimText} ${supportingEvidence}`, experience.structured ?? {})]).slice(0, 16),
    confidence,
    riskLevel,
  };
}

function selectSupportingEvidence(rawEvidence: string | undefined, claim: string, source: string): string | undefined {
  const candidates = unique([
    ...(rawEvidence?.trim() ? [rawEvidence.trim()] : []),
    ...splitSentences(source, 30),
  ]);
  if (candidates.length === 0) return undefined;
  const claimTerms = extractKeywords(claim, 18);
  return candidates
    .map((candidate) => ({ candidate, score: scoreTextOverlap(claimTerms, candidate).score }))
    .sort((a, b) => b.score - a.score)[0]?.candidate;
}

function inferSkills(text: string, structured: Record<string, unknown>): string[] {
  return unique([
    ...arrayOfStrings(structured.skills),
    ...arrayOfStrings(structured.techStack),
    ...arrayOfStrings(structured.technologies),
    ...arrayOfStrings(structured.methods),
    ...extractKeywords(text, 20),
  ]).slice(0, 16);
}

function confidenceForText(text: string, structured: Record<string, unknown>): number {
  let confidence = 0.58;
  if (extractNumbers(text).length > 0) confidence += 0.12;
  if (arrayOfStrings(structured.highlights).some((item) => normalizeText(item) === normalizeText(text))) confidence += 0.1;
  if (text.length >= 20 && text.length <= 220) confidence += 0.06;
  if (/可能|大约|about|approximately|maybe|或许/u.test(text)) confidence -= 0.12;
  return clamp(confidence);
}

function riskForText(claim: string, source: string): ExperienceClaim["riskLevel"] {
  const normalizedClaim = normalizeText(claim);
  const normalizedSource = normalizeText(source);
  const hasOwnership = OWNERSHIP_TERMS.some((term) => normalizedClaim.includes(normalizeText(term)));
  const hasImpact = IMPACT_TERMS.some((term) => normalizedClaim.includes(normalizeText(term)));
  const hasMetrics = extractNumbers(claim).length > 0;
  if (hasOwnership && !OWNERSHIP_TERMS.some((term) => normalizedSource.includes(normalizeText(term)))) return "high";
  if ((hasImpact || hasMetrics) && !normalizeText(source).includes(normalizedClaim)) return "medium";
  if (hasOwnership || hasImpact || hasMetrics) return "medium";
  return "low";
}

function normalizeRisk(value: unknown, fallback: ExperienceClaim["riskLevel"]): ExperienceClaim["riskLevel"] {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function mergeClaims(claims: ExperienceClaim[]): ExperienceClaim[] {
  const result: ExperienceClaim[] = [];
  for (const claim of claims) {
    const normalized = normalizeText(claim.claim);
    if (!normalized) continue;
    const duplicateIndex = result.findIndex((existing) => {
      const other = normalizeText(existing.claim);
      if (normalized === other) return true;
      const overlap = scoreTextOverlap(extractKeywords(normalized, 16), other).score;
      return overlap >= 0.72 && Math.abs(normalized.length - other.length) < 80;
    });
    if (duplicateIndex < 0) {
      result.push(claim);
      continue;
    }
    const existing = result[duplicateIndex];
    if (claim.confidence > existing.confidence) {
      result[duplicateIndex] = {
        ...claim,
        skills: unique([...claim.skills, ...existing.skills]).slice(0, 16),
      };
    } else {
      existing.skills = unique([...existing.skills, ...claim.skills]).slice(0, 16);
    }
  }
  return result.sort((a, b) => b.confidence - a.confidence);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function metricsToStrings(value: unknown): string[] {
  if (Array.isArray(value)) return arrayOfStrings(value);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, metric]) => typeof metric === "string" || typeof metric === "number")
    .map(([key, metric]) => `${key}: ${String(metric)}`);
}
