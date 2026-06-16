import type { ProductGeneratedVariant } from "../../product/types.js";
import type { AllowedClaim, EvidencePack } from "./types.js";
import {
  extractNumbers,
  normalizeText,
  phraseMatchScore,
  splitSentences,
  tokenize,
  unique,
} from "./textUtils.js";

const FACTUAL_PATTERNS = [
  /\b(led|owned|drove|managed|launched|built|implemented|designed|developed|trained|evaluated|published|increased|improved|reduced|grew|delivered|won|received)\b/i,
  /\d+(?:\.\d+)?\s*(%|％|users?|clients?|customers?|reports?|projects?|days?|weeks?|months?|years?|papers?|patents?|awards?)/i,
  /主导|负责|管理|上线|构建|实现|设计|开发|训练|评估|发表|提升|增长|降低|获得|获奖|专利|论文/,
];

const SOFT_NON_FACTUAL_PATTERNS = [
  /^目标岗位[:：]/,
  /^summary[:：]?$/i,
  /^skills?[:：]?$/i,
  /^education[:：]?$/i,
  /^experience[:：]?$/i,
  /^projects?[:：]?$/i,
];

export class ClaimSupportVerifier {
  public verifyVariants(variants: ProductGeneratedVariant[], evidencePack: EvidencePack): ProductGeneratedVariant[] {
    return variants.map((variant) => this.verifyVariant(variant, evidencePack));
  }

  private verifyVariant(variant: ProductGeneratedVariant, evidencePack: EvidencePack): ProductGeneratedVariant {
    const sentences = splitSentences(variant.content, 80).filter((sentence) => sentence.trim().length > 3);
    const traces = sentences.map((sentence) => matchSentenceToClaims(sentence, evidencePack.allowedClaims));
    const unsupportedClaims = traces
      .filter((trace) => trace.support === "unsupported" && isFactualSentence(trace.text))
      .map((trace) => trace.text);
    const partialClaims = traces
      .filter((trace) => trace.support === "partial" && isFactualSentence(trace.text))
      .map((trace) => trace.text);
    const supportedClaimIds = unique(traces.flatMap((trace) => trace.claimIds));
    const supportedExperienceIds = unique(traces.flatMap((trace) => trace.experienceIds));
    const selectedClaims = evidencePack.allowedClaims.filter((claim) => supportedClaimIds.includes(claim.claimId ?? claim.id));
    const missingEvidence = evidencePack.missingRequirements.map((item) => item.requirementText).slice(0, 10);
    const warnings = unique([
      ...(variant.riskSummary?.warnings ?? []),
      ...(unsupportedClaims.length > 0 ? ["Generated factual statements were found outside the verified Evidence Pack boundary."] : []),
      ...(partialClaims.length > 0 ? ["Some statements are only partially supported and should be reviewed conservatively."] : []),
      ...(missingEvidence.length > 0 ? ["Some JD requirements have no verified user evidence and were intentionally left uncovered."] : []),
    ]).slice(0, 10);

    const level: "low" | "medium" | "high" | "critical" = unsupportedClaims.length > 0
      ? "high"
      : partialClaims.length > 0 || missingEvidence.length > 0
        ? "medium"
        : variant.riskSummary?.level ?? "low";

    return {
      ...variant,
      sourceExperienceIds: supportedExperienceIds.length > 0
        ? supportedExperienceIds.slice(0, 12)
        : unique(variant.sourceExperienceIds ?? []).filter((id) => evidencePack.allowedClaims.some((claim) => claim.experienceId === id)).slice(0, 12),
      sourceEvidenceIds: supportedClaimIds.length > 0
        ? supportedClaimIds.slice(0, 30)
        : unique(variant.sourceEvidenceIds ?? []).filter((id) => evidencePack.allowedClaims.some((claim) => (claim.claimId ?? claim.id) === id)).slice(0, 30),
      evidenceSummary: buildEvidenceSummary(evidencePack, selectedClaims),
      riskSummary: {
        level,
        unsupportedClaims: unique([...(variant.riskSummary?.unsupportedClaims ?? []), ...unsupportedClaims]).slice(0, 14),
        missingEvidence: unique([...(variant.riskSummary?.missingEvidence ?? []), ...missingEvidence]).slice(0, 14),
        warnings,
      },
      missingInfo: unique([
        ...(variant.missingInfo ?? []),
        ...missingEvidence.map((item) => `Add or confirm evidence for: ${item}`),
      ]).slice(0, 14),
      groundingTrace: traces,
    };
  }
}

function matchSentenceToClaims(sentence: string, claims: AllowedClaim[]): NonNullable<ProductGeneratedVariant["groundingTrace"]>[number] {
  if (SOFT_NON_FACTUAL_PATTERNS.some((pattern) => pattern.test(sentence.trim()))) {
    return {
      text: sentence,
      support: "supported",
      claimIds: [],
      experienceIds: [],
      confidence: 1,
      reason: "Section heading or non-factual structural text.",
    };
  }
  const candidates = claims
    .map((claim) => ({ claim, ...scoreSentenceClaim(sentence, claim) }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.24) {
    return {
      text: sentence,
      support: isFactualSentence(sentence) ? "unsupported" : "partial",
      claimIds: [],
      experienceIds: [],
      confidence: Number(Math.max(0, best?.score ?? 0).toFixed(3)),
      reason: "No sufficiently similar verified claim was found.",
    };
  }
  const selected = candidates.filter((item) => item.score >= Math.max(0.28, best.score - 0.12)).slice(0, 3);
  const hasNumberMismatch = selected.every((item) => !item.numbersSupported);
  const support = hasNumberMismatch
    ? "partial"
    : best.score >= 0.48
      ? "supported"
      : "partial";
  return {
    text: sentence,
    support,
    claimIds: unique(selected.map((item) => item.claim.claimId ?? item.claim.id)),
    experienceIds: unique(selected.map((item) => item.claim.experienceId)),
    confidence: Number(Math.min(1, selected.reduce((sum, item) => sum + item.score, 0) / selected.length).toFixed(3)),
    reason: hasNumberMismatch
      ? "Wording overlaps verified claims, but one or more numbers are not supported by the source evidence."
      : `Matched ${selected.length} verified claim(s) using phrase, term, and evidence overlap.`,
  };
}

function scoreSentenceClaim(sentence: string, claim: AllowedClaim): { score: number; numbersSupported: boolean } {
  const sentenceText = normalizeText(sentence);
  const sourceText = normalizeText(`${claim.claim} ${claim.evidenceText}`);
  const sentenceTerms = unique(tokenize(sentenceText).filter((term) => term.length >= 2));
  const sourceTerms = new Set(tokenize(sourceText));
  const matched = sentenceTerms.filter((term) => sourceTerms.has(term));
  const lexical = matched.length / Math.max(1, Math.min(sentenceTerms.length, 14));
  const phrase = Math.max(
    phraseMatchScore([claim.claim], sentenceText).score,
    phraseMatchScore([claim.evidenceText], sentenceText).score,
  );
  const sentenceNumbers = extractNumbers(sentence);
  const sourceNumbers = new Set(extractNumbers(`${claim.claim} ${claim.evidenceText}`));
  const numbersSupported = sentenceNumbers.length === 0 || sentenceNumbers.every((number) => sourceNumbers.has(number));
  const numberPenalty = numbersSupported ? 0 : 0.34;
  const riskPenalty = claim.riskLevel === "high" ? 0.08 : claim.riskLevel === "medium" ? 0.03 : 0;
  const score = Math.max(0, Math.min(1, lexical * 0.48 + phrase * 0.34 + claim.confidence * 0.18 - numberPenalty - riskPenalty));
  return { score, numbersSupported };
}

function isFactualSentence(sentence: string): boolean {
  return FACTUAL_PATTERNS.some((pattern) => pattern.test(sentence)) || extractNumbers(sentence).length > 0;
}

function buildEvidenceSummary(evidencePack: EvidencePack, selectedClaims: AllowedClaim[]): ProductGeneratedVariant["evidenceSummary"] {
  const source = selectedClaims.length > 0 ? selectedClaims : evidencePack.allowedClaims.slice(0, 4);
  const items = source.slice(0, 8).map((claim) => ({
    id: claim.claimId ?? claim.id,
    title: claim.claim.slice(0, 90),
    explanation: `Experience ${claim.experienceId}: ${claim.evidenceText}`,
    confidence: claim.confidence,
  }));
  const covered = evidencePack.matchedEvidence.filter((item) => item.coverage !== "no_evidence").length;
  return {
    coverageLabel: `Verified evidence covers ${covered} of ${evidencePack.jdRequirements.length} parsed JD requirements; ${selectedClaims.length} claim(s) were directly mapped to this variant.`,
    items,
  };
}
