import type { EvidencePack, JDRequirement } from "../../rag/evidence/index.js";
import type { ProductExperienceSummary } from "../types.js";
import type { ATSKeywordCoverageReport } from "./types.js";

export class ATSKeywordCoverageService {
  public analyze(input: {
    requirements: JDRequirement[];
    sourceExperiences: ProductExperienceSummary[];
    evidencePack?: EvidencePack;
  }): ATSKeywordCoverageReport {
    const keywordMap = collectRequirementKeywords(input.requirements);
    const sourceTexts = input.sourceExperiences.map((experience) => ({
      experienceId: experience.id,
      text: searchableExperienceText(experience),
    }));
    const claims = input.evidencePack?.allowedClaims ?? [];

    const items = [...keywordMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([keyword, requirementIds]) => {
        const normalized = keyword.toLowerCase();
        const matchedSourceExperienceIds = sourceTexts
          .filter((item) => item.text.includes(normalized))
          .map((item) => item.experienceId);
        const matchedClaims = claims.filter((claim) =>
          claim.claim.toLowerCase().includes(normalized)
          || claim.evidenceText.toLowerCase().includes(normalized)
          || claim.requirementIds.some((id) => requirementIds.includes(id)),
        );
        const evidenceIds = matchedClaims
          .map((claim) => claim.claimId ?? claim.id)
          .filter((id, index, all) => id && all.indexOf(id) === index);
        return {
          keyword,
          requirementIds,
          matched: matchedSourceExperienceIds.length > 0 || evidenceIds.length > 0,
          matchedSourceExperienceIds,
          evidenceIds,
        };
      });

    const matchedKeywords = items.filter((item) => item.matched).length;
    return {
      totalKeywords: items.length,
      matchedKeywords,
      missingKeywords: items.length - matchedKeywords,
      coverageRatio: items.length > 0 ? roundRatio(matchedKeywords / items.length) : 1,
      items,
    };
  }
}

export function searchableExperienceText(experience: ProductExperienceSummary): string {
  return [
    experience.title,
    experience.organization,
    experience.role,
    experience.content,
    ...collectStructuredTerms(experience.structured),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function collectRequirementKeywords(requirements: JDRequirement[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const requirement of requirements) {
    const keywords = [
      ...requirement.keywords,
      ...requirement.coreTerms,
      ...extractKeywordTerms(requirement.text),
    ];
    for (const raw of keywords) {
      const keyword = normalizeKeyword(raw);
      if (!keyword || STOPWORDS.has(keyword)) continue;
      const existing = map.get(keyword) ?? [];
      if (!existing.includes(requirement.id)) existing.push(requirement.id);
      map.set(keyword, existing);
    }
  }
  return map;
}

function collectStructuredTerms(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStructuredTerms(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStructuredTerms(item));
  }
  return [];
}

function extractKeywordTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z][a-z0-9+#./-]{1,32}/g) ?? [];
  const cjk = lower.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  return [...ascii, ...cjk];
}

function normalizeKeyword(value: string): string | undefined {
  const keyword = value.toLowerCase().replace(/^[^\p{L}\p{N}+#./-]+|[^\p{L}\p{N}+#./-]+$/gu, "");
  if (keyword.length < 2) return undefined;
  if (/^\d+$/.test(keyword)) return undefined;
  return keyword;
}

function roundRatio(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

const STOPWORDS = new Set([
  "and",
  "or",
  "the",
  "with",
  "for",
  "you",
  "we",
  "our",
  "your",
  "in",
  "on",
  "at",
  "to",
  "of",
  "a",
  "an",
  "is",
  "are",
  "be",
  "as",
  "by",
  "have",
  "has",
  "must",
  "should",
  "will",
  "can",
  "able",
  "experience",
  "skill",
  "skills",
  "required",
  "preferred",
  "team",
  "role",
  "candidate",
  "responsible",
]);
