import type {
  EvidenceRAGExperience,
  JDRequirement,
  ProductExperienceClaim,
  RequirementQueryPlan,
  RetrievalMode,
  RetrievalStrategyScores,
} from "./types.js";
import {
  buildDocumentFrequency,
  clamp,
  expandDomainTerms,
  isGenericSkillTerm,
  normalizeText,
  phraseMatchScore,
  scoreTextOverlap,
  stringifyStructured,
  termWeight,
  unique,
} from "./textUtils.js";

export type RequirementScore = {
  requirementId: string;
  score: number;
  matchedTerms: string[];
  strategyScores: RetrievalStrategyScores;
};

export type CorpusStats = {
  documentFrequency: Map<string, number>;
  corpusSize: number;
};

export function buildExperienceCorpusStats(experiences: EvidenceRAGExperience[]): CorpusStats {
  const documents = experiences.map((experience) => experienceSearchableText(experience));
  return { documentFrequency: buildDocumentFrequency(documents), corpusSize: documents.length };
}

export function buildClaimCorpusStats(claims: ProductExperienceClaim[]): CorpusStats {
  const documents = claims.map((claim) => claimSearchableText(claim));
  return { documentFrequency: buildDocumentFrequency(documents), corpusSize: documents.length };
}

export function scoreExperience(
  experience: EvidenceRAGExperience,
  requirements: JDRequirement[],
  plans: Map<string, RequirementQueryPlan>,
  corpus: CorpusStats,
  mode: RetrievalMode,
): { score: number; requirementScores: RequirementScore[]; matchedTerms: string[]; matchedRequirementIds: string[]; strategyScores: RetrievalStrategyScores } {
  const structured = stringifyStructured(experience.structured);
  const fields = [
    { value: experience.title, weight: 1.45 },
    { value: experience.role, weight: 1.35 },
    { value: (experience.tags ?? []).join(" "), weight: 1.3 },
    { value: structured, weight: 1.25 },
    { value: experience.content, weight: 1 },
    { value: experience.organization, weight: 0.65 },
  ];

  const requirementScores = requirements.map((requirement) => {
    const plan = plans.get(requirement.id) ?? fallbackPlan(requirement);
    let lexical = 0;
    let exactPhrase = 0;
    const matchedTerms: string[] = [];
    for (const field of fields) {
      const overlap = scoreTextOverlap(plan.expandedTerms, field.value, corpus);
      lexical = Math.max(lexical, overlap.score * field.weight);
      matchedTerms.push(...overlap.matchedTerms);
      const phrase = phraseMatchScore(plan.phrases, field.value);
      exactPhrase = Math.max(exactPhrase, phrase.score * field.weight);
      matchedTerms.push(...phrase.matchedPhrases);
    }

    const structuredSkill = scoreStructuredSkill(plan, experience.tags ?? [], structured);
    const semanticAlias = scoreSemanticAliases(plan, experienceSearchableText(experience), corpus);
    const categoryFit = categoryCompatibility(requirement, experience.category);
    const strictPenalty = strictnessPenalty(plan.strictness, mode, lexical, exactPhrase, structuredSkill, semanticAlias);
    const strategyScores: RetrievalStrategyScores = {
      exactPhrase: clamp(exactPhrase),
      lexical: clamp(lexical),
      structured: clamp(structuredSkill),
      semanticAlias: clamp(semanticAlias),
      categoryFit: clamp(categoryFit),
    };
    const score = clamp((
      exactPhrase * 0.3
      + lexical * 0.32
      + structuredSkill * 0.22
      + semanticAlias * 0.1
      + categoryFit * 0.06
    ) * importanceWeight(requirement.importance) * policyWeight(requirement) * strictPenalty);
    return {
      requirementId: requirement.id,
      score,
      matchedTerms: unique(matchedTerms).sort((a, b) => termWeight(b, corpus) - termWeight(a, corpus)).slice(0, 18),
      strategyScores,
    };
  });

  return aggregateScores(requirementScores, mode);
}

export function scoreClaim(
  claim: ProductExperienceClaim,
  requirements: JDRequirement[],
  plans: Map<string, RequirementQueryPlan>,
  corpus: CorpusStats,
  mode: RetrievalMode,
  longTermEffectiveness = 0,
): { score: number; requirementScores: RequirementScore[]; matchedTerms: string[]; matchedRequirementIds: string[]; strategyScores: RetrievalStrategyScores } {
  const searchable = claimSearchableText(claim);
  const requirementScores = requirements.map((requirement) => {
    const plan = plans.get(requirement.id) ?? fallbackPlan(requirement);
    const lexicalResult = scoreTextOverlap(plan.expandedTerms, searchable, corpus);
    const phraseResult = phraseMatchScore(plan.phrases, searchable);
    const structuredSkill = scoreStructuredSkill(plan, claim.skills, claim.skills.join(" "));
    const semanticAlias = scoreSemanticAliases(plan, searchable, corpus);
    const categoryFit = categoryCompatibility(requirement, String(claim.metadata.category ?? claim.claimType));
    const riskPenalty = claim.riskLevel === "high" ? 0.68 : claim.riskLevel === "medium" ? 0.86 : 1;
    const strictPenalty = strictnessPenalty(plan.strictness, mode, lexicalResult.score, phraseResult.score, structuredSkill, semanticAlias);
    const strategyScores: RetrievalStrategyScores = {
      exactPhrase: phraseResult.score,
      lexical: lexicalResult.score,
      structured: structuredSkill,
      semanticAlias,
      categoryFit,
      longTermEffectiveness: clamp(longTermEffectiveness),
    };
    const score = clamp((
      phraseResult.score * 0.32
      + lexicalResult.score * 0.31
      + structuredSkill * 0.2
      + semanticAlias * 0.09
      + categoryFit * 0.04
      + clamp(longTermEffectiveness) * 0.04
    ) * importanceWeight(requirement.importance) * policyWeight(requirement) * riskPenalty * strictPenalty);
    return {
      requirementId: requirement.id,
      score,
      matchedTerms: unique([...lexicalResult.matchedTerms, ...phraseResult.matchedPhrases])
        .sort((a, b) => termWeight(b, corpus) - termWeight(a, corpus))
        .slice(0, 18),
      strategyScores,
    };
  });

  const aggregated = aggregateScores(requirementScores, mode);
  const confidenceFactor = 0.82 + claim.confidence * 0.18;
  return { ...aggregated, score: clamp(aggregated.score * confidenceFactor) };
}

export function minimumRetrievalScore(mode: RetrievalMode): number {
  return mode === "corrective" ? 0.105 : 0.14;
}

export function hasStrongMatch(result: { requirementScores: RequirementScore[]; matchedTerms: string[] }, mode: RetrievalMode): boolean {
  const strongest = result.requirementScores.reduce((max, item) => Math.max(max, item.score), 0);
  const strongTerms = result.matchedTerms.filter((term) => termWeight(term) >= 0.9);
  return strongest >= (mode === "corrective" ? 0.12 : 0.16) && strongTerms.length > 0;
}

export function experienceSearchableText(experience: EvidenceRAGExperience): string {
  return [
    experience.title,
    experience.organization,
    experience.role,
    experience.category,
    experience.content,
    ...(experience.tags ?? []),
    stringifyStructured(experience.structured),
  ].filter(Boolean).join("\n");
}

export function claimSearchableText(claim: ProductExperienceClaim): string {
  return [claim.claim, claim.evidenceText, claim.skills.join(" "), claim.claimType, String(claim.metadata.category ?? "")].join("\n");
}

function aggregateScores(requirementScores: RequirementScore[], mode: RetrievalMode): {
  score: number;
  requirementScores: RequirementScore[];
  matchedTerms: string[];
  matchedRequirementIds: string[];
  strategyScores: RetrievalStrategyScores;
} {
  const selected = requirementScores
    .filter((item) => item.score > 0.04)
    .sort((a, b) => b.score - a.score);
  const top = selected.slice(0, 4);
  const weighted = top.reduce((sum, item, index) => sum + item.score * [1, 0.75, 0.55, 0.4][index], 0);
  const denominator = top.length === 0 ? 1 : [1, 0.75, 0.55, 0.4].slice(0, top.length).reduce((sum, value) => sum + value, 0);
  const coverageBonus = Math.min(0.12, selected.length * 0.025);
  const score = clamp(weighted / denominator + coverageBonus + (mode === "corrective" ? 0.01 : 0));
  return {
    score,
    requirementScores,
    matchedTerms: unique(top.flatMap((item) => item.matchedTerms)).slice(0, 20),
    matchedRequirementIds: top.map((item) => item.requirementId),
    strategyScores: maxStrategyScores(top.map((item) => item.strategyScores)),
  };
}

function maxStrategyScores(items: RetrievalStrategyScores[]): RetrievalStrategyScores {
  return {
    exactPhrase: Math.max(0, ...items.map((item) => item.exactPhrase)),
    lexical: Math.max(0, ...items.map((item) => item.lexical)),
    structured: Math.max(0, ...items.map((item) => item.structured)),
    semanticAlias: Math.max(0, ...items.map((item) => item.semanticAlias)),
    categoryFit: Math.max(0, ...items.map((item) => item.categoryFit)),
    longTermEffectiveness: Math.max(0, ...items.map((item) => item.longTermEffectiveness ?? 0)),
  };
}

function scoreStructuredSkill(plan: RequirementQueryPlan, skills: string[], structuredText: string): number {
  const normalizedSkills = new Set(skills.flatMap((skill) => [normalizeText(skill), ...expandDomainTerms(skill)]));
  const normalizedStructured = normalizeText(structuredText);
  const importantTerms = unique([...plan.coreTerms, ...plan.expandedTerms.filter((term) => termWeight(term) >= 1.1)]);
  if (importantTerms.length === 0) return 0;
  let score = 0;
  for (const term of importantTerms) {
    const normalized = normalizeText(term);
    if (normalizedSkills.has(normalized)) score += isGenericSkillTerm(normalized) ? 0.45 : 1;
    else if (normalized.length >= 3 && normalizedStructured.includes(normalized)) score += isGenericSkillTerm(normalized) ? 0.25 : 0.7;
  }
  return clamp(score / Math.max(1, Math.min(importantTerms.length, 5)));
}

function scoreSemanticAliases(plan: RequirementQueryPlan, searchable: string, corpus: CorpusStats): number {
  const aliases = unique(plan.expandedTerms.flatMap((term) => expandDomainTerms(term)));
  if (aliases.length === 0) return 0;
  return scoreTextOverlap(aliases, searchable, corpus).score;
}

function categoryCompatibility(requirement: JDRequirement, category: string): number {
  const normalizedCategory = normalizeText(category);
  if (requirement.category === "skill") return normalizedCategory === "skill" || normalizedCategory === "project" || normalizedCategory === "work" || normalizedCategory === "internship" ? 1 : 0.35;
  if (requirement.category === "responsibility") return ["work", "internship", "project", "responsibility", "achievement"].some((item) => normalizedCategory.includes(item)) ? 1 : 0.25;
  if (requirement.category === "qualification") {
    if (/degree|education|award|publication|education|award|学历|教育|论文|专利/.test(normalizeText(requirement.text))) {
      return /education|award|research|教育|奖项/.test(normalizedCategory) ? 1 : 0.3;
    }
    return 0.7;
  }
  if (requirement.category === "nice_to_have") return 0.6;
  return 0.65;
}

function strictnessPenalty(
  strictness: RequirementQueryPlan["strictness"],
  mode: RetrievalMode,
  lexical: number,
  phrase: number,
  structured: number,
  semantic: number,
): number {
  const strongest = Math.max(lexical, phrase, structured, semantic);
  if (strictness === "strict") {
    if (strongest < (mode === "corrective" ? 0.12 : 0.17)) return 0.25;
    if (phrase === 0 && structured === 0 && lexical < 0.22) return 0.6;
  }
  if (strictness === "balanced" && strongest < 0.09) return 0.55;
  return 1;
}

function importanceWeight(value: JDRequirement["importance"]): number {
  if (value === "critical") return 1.22;
  if (value === "high") return 1.1;
  if (value === "low") return 0.78;
  return 1;
}

function policyWeight(requirement: JDRequirement): number {
  let weight = 1;
  if (requirement.retrievalPolicies.includes("keyword_exact")) weight += 0.05;
  if (requirement.retrievalPolicies.includes("structured_skill")) weight += 0.05;
  if (requirement.retrievalPolicies.includes("claim_verification")) weight += 0.03;
  return weight;
}

function fallbackPlan(requirement: JDRequirement): RequirementQueryPlan {
  return {
    requirementId: requirement.id,
    originalText: requirement.text,
    coreTerms: requirement.coreTerms,
    expandedTerms: requirement.keywords,
    phrases: requirement.queryVariants,
    policies: requirement.retrievalPolicies,
    strictness: requirement.strictness,
  };
}
