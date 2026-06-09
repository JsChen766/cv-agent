import type { AllowedClaim, EvidenceGraphLink, EvidenceItem, JDRequirement } from "./types.js";
import { normalizeText, unique } from "./textUtils.js";

export class EvidenceGraphBuilder {
  public build(input: {
    requirements: JDRequirement[];
    allowedClaims: AllowedClaim[];
    evidenceItems: EvidenceItem[];
  }): EvidenceGraphLink[] {
    const links: EvidenceGraphLink[] = [];
    const evidenceByClaim = new Map<string, EvidenceItem>();
    for (const item of input.evidenceItems) {
      for (const claim of item.supportedClaims) evidenceByClaim.set(normalizeText(claim), item);
    }

    for (const claim of input.allowedClaims) {
      links.push({
        sourceType: "experience",
        sourceId: claim.experienceId,
        relation: "supports",
        targetType: "claim",
        targetId: claim.claimId ?? claim.id,
        confidence: claim.confidence,
      });
      for (const requirementId of claim.requirementIds) {
        links.push({
          sourceType: "claim",
          sourceId: claim.claimId ?? claim.id,
          relation: claim.confidence >= 0.7 ? "covers" : "partially_covers",
          targetType: "requirement",
          targetId: requirementId,
          confidence: claim.confidence,
        });
      }
      const evidence = evidenceByClaim.get(normalizeText(claim.claim));
      for (const skill of evidence?.skills ?? []) {
        const skillId = `skill-${normalizeText(skill).replace(/\s+/g, "-")}`;
        links.push({
          sourceType: "claim",
          sourceId: claim.claimId ?? claim.id,
          relation: "demonstrates",
          targetType: "skill",
          targetId: skillId,
          confidence: claim.confidence,
        });
        for (const requirement of input.requirements) {
          if (requirement.keywords.some((keyword) => normalizeText(keyword) === normalizeText(skill))) {
            links.push({
              sourceType: "skill",
              sourceId: skillId,
              relation: "requires",
              targetType: "requirement",
              targetId: requirement.id,
              confidence: claim.confidence,
            });
          }
        }
      }
    }

    return uniqueLinks(links);
  }
}

function uniqueLinks(links: EvidenceGraphLink[]): EvidenceGraphLink[] {
  const seen = new Set<string>();
  const result: EvidenceGraphLink[] = [];
  for (const link of links) {
    const key = `${link.sourceType}:${link.sourceId}:${link.relation}:${link.targetType}:${link.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}
