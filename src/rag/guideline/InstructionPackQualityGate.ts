import type { GuidelineRoleAnalysis, InstructionPack, RetrievedGuideline } from "./types.js";
import { normalizeText, unique } from "./textUtils.js";

const MANDATORY_CONSTRAINTS = [
  "Do not invent companies, roles, projects, skills, metrics, leadership, users, launches, publications, awards, or outcomes.",
  "Use only facts supported by the Evidence Pack; when evidence is missing, omit the claim or request user confirmation.",
  "Preserve the user's actual ownership level and do not upgrade participation into leadership without explicit evidence.",
];

export class InstructionPackQualityGate {
  public finalize(input: {
    pack: InstructionPack;
    analysis: GuidelineRoleAnalysis;
    retrieved: RetrievedGuideline[];
    queryPlan: InstructionPack["queryPlan"];
  }): InstructionPack {
    const conflictsResolved: string[] = [];
    const originalRuleCount = input.pack.writingRules.length + input.pack.negativeConstraints.length;
    const hardConstraints = dedupeMeaning([...MANDATORY_CONSTRAINTS, ...(input.pack.hardConstraints ?? []), ...input.pack.negativeConstraints]);
    const writingRules = dedupeMeaning(input.pack.writingRules.filter((rule) => !contradictsTruthBoundary(rule, hardConstraints)));
    if (writingRules.length < input.pack.writingRules.length) conflictsResolved.push("Removed writing rules that could encourage unsupported claims.");
    const negativeConstraints = dedupeMeaning([...input.pack.negativeConstraints, ...hardConstraints]);
    const examplePatterns = input.pack.examplePatterns
      .map((item) => ({ ...item, pattern: sanitizePattern(item.pattern) }))
      .filter((item) => item.pattern.length > 8)
      .slice(0, 10);
    const sourceTypeCoverage = unique(input.retrieved.map((item) => item.guideline.sourceType));
    const roleSpecificGuidelineCount = input.retrieved.filter((item) => item.guideline.roleFamily === input.analysis.roleFamily).length;
    const warnings: string[] = [];
    if (roleSpecificGuidelineCount === 0) warnings.push("No role-specific guideline was retrieved; general rules were used.");
    if (sourceTypeCoverage.length < 2) warnings.push("Guideline source diversity is limited.");
    if (examplePatterns.length === 0) warnings.push("No safe example pattern was available.");
    const sectionStrategy = {
      summary: input.pack.sectionStrategy.summary ?? "Use a summary only when evidence strongly supports a concise target-role positioning.",
      experience: input.pack.sectionStrategy.experience ?? "Rank experiences by JD relevance, evidence strength, and verified contribution.",
      project: input.pack.sectionStrategy.project ?? "State the problem, method, personal contribution, and verified result without inflating ownership.",
      skills: input.pack.sectionStrategy.skills ?? "List only skills supported by user-provided experience or explicit profile data.",
      education: input.pack.sectionStrategy.education ?? "Keep education and honors concise unless directly relevant to the target role.",
    };
    return {
      ...input.pack,
      version: "guideline-rag-v2",
      roleFamily: input.analysis.roleFamily,
      applicationType: input.analysis.applicationType,
      language: input.analysis.language,
      sectionStrategy,
      sectionBudgets: input.pack.sectionBudgets ?? {
        summary: "0-3 concise lines; omit if it adds no evidence-backed value.",
        experience: "Prioritize 2-4 strongest relevant experiences and 2-4 bullets per major item.",
        project: "Use only projects that add distinct evidence not already covered by work experience.",
        skills: "Compact grouped list; remove unsupported or low-relevance keywords.",
        education: "One compact entry per degree, with only relevant honors or coursework.",
      },
      hardConstraints,
      negativeConstraints,
      writingRules,
      softPreferences: dedupeMeaning(input.pack.softPreferences ?? writingRules).slice(0, 14),
      examplePatterns,
      queryPlan: input.queryPlan,
      quality: {
        status: warnings.length > 1 ? "needs_review" : "ready",
        mandatoryConstraintsPresent: MANDATORY_CONSTRAINTS.every((constraint) => negativeConstraints.some((rule) => semanticContains(rule, constraint))),
        sourceTypeCoverage,
        roleSpecificGuidelineCount,
        duplicateRulesRemoved: Math.max(0, originalRuleCount - writingRules.length - input.pack.negativeConstraints.length),
        conflictsResolved,
        warnings,
      },
    };
  }
}

function dedupeMeaning(items: string[]): string[] {
  const output: string[] = [];
  const keys: string[] = [];
  for (const raw of items) {
    const value = raw.trim();
    if (!value) continue;
    const key = normalizeText(value).replace(/\b(the|a|an|to|of|and|or|should|must)\b/g, " ").replace(/\s+/g, " ").trim();
    if (keys.some((existing) => overlap(existing, key) >= 0.78)) continue;
    keys.push(key);
    output.push(value);
  }
  return output.slice(0, 18);
}

function contradictsTruthBoundary(rule: string, hardConstraints: string[]): boolean {
  const normalized = normalizeText(rule);
  if (!/invent|fabricat|assume|create metric|夸大|编造|虚构/.test(normalized)) return false;
  return !hardConstraints.some((constraint) => semanticContains(rule, constraint));
}

function sanitizePattern(pattern: string): string {
  return pattern
    .replace(/\b[A-Z][A-Za-z0-9&.-]{2,}\s+(Inc\.?|Ltd\.?|University|Corporation|Corp\.?)\b/g, "[Organization]")
    .replace(/\b\d+(?:\.\d+)?\s*%\b/g, "[verified metric]")
    .replace(/\b\d{2,}\s+(users?|customers?|clients?|projects?|papers?)\b/gi, "[verified scope]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function semanticContains(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  return na.includes(nb) || nb.includes(na) || overlap(na, nb) >= 0.42;
}

function overlap(a: string, b: string): number {
  const aa = new Set(a.split(/\s+/).filter(Boolean));
  const bb = new Set(b.split(/\s+/).filter(Boolean));
  if (aa.size === 0 || bb.size === 0) return 0;
  const common = Array.from(aa).filter((term) => bb.has(term)).length;
  return common / Math.min(aa.size, bb.size);
}
