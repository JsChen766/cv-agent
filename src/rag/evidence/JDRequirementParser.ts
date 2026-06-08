import type { JDRequirement, JDRequirementCategory, JDRequirementEvidenceType, JDRequirementImportance } from "./types.js";
import { RequirementPolicyRouter } from "./RequirementPolicyRouter.js";
import { extractKeywords, normalizeText, unique } from "./textUtils.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";

export class JDRequirementParser {
  private readonly router = new RequirementPolicyRouter();

  public constructor(private readonly llmEvidenceService?: LLMEvidenceService) {}

  public async parse(input: { jdText: string; targetRole?: string }): Promise<JDRequirement[]> {
    if (this.llmEvidenceService) {
      try {
        const parsed = await this.llmEvidenceService.parseJDRequirements(input);
        const normalized = parsed
          .map((item, index) => normalizeRequirement(item, index))
          .filter((item): item is Omit<JDRequirement, "retrievalPolicies" | "keywords"> => Boolean(item));
        if (normalized.length > 0) return this.router.enrich(normalized).slice(0, 24);
      } catch {
        // Fall through to deterministic parsing. Evidence RAG should never block generation only because JD parsing failed.
      }
    }
    return this.parseDeterministic(input.jdText, input.targetRole);
  }

  private parseDeterministic(jdText: string, targetRole?: string): JDRequirement[] {
    const chunks = splitRequirementChunks(jdText);
    const extracted = chunks.map((text, index) => normalizeRequirement({
      text,
      category: inferCategory(text),
      importance: inferImportance(text),
      evidenceType: inferEvidenceType(text),
    }, index)).filter((item): item is Omit<JDRequirement, "retrievalPolicies" | "keywords"> => Boolean(item));

    const skills = extractSkillRequirements(jdText).map((skill, index) => normalizeRequirement({
      text: skill,
      category: "skill",
      importance: "high",
      evidenceType: "keyword_presence",
    }, extracted.length + index)).filter((item): item is Omit<JDRequirement, "retrievalPolicies" | "keywords"> => Boolean(item));

    const roleRequirement = targetRole?.trim()
      ? normalizeRequirement({
          text: `Target positioning for ${targetRole.trim()}`,
          category: "role_positioning",
          importance: "medium",
          evidenceType: "experience_analogy",
        }, 0)
      : undefined;

    const base = uniqueByText([roleRequirement, ...extracted, ...skills].filter((item): item is Omit<JDRequirement, "retrievalPolicies" | "keywords"> => Boolean(item)));
    return this.router.enrich(base).slice(0, 24);
  }
}

function normalizeRequirement(item: Partial<JDRequirement>, index: number): Omit<JDRequirement, "retrievalPolicies" | "keywords"> | null {
  const text = item.text?.trim();
  if (!text || text.length < 2) return null;
  return {
    id: item.id?.trim() || `req-${index + 1}`,
    text: text.slice(0, 300),
    category: normalizeCategory(item.category, text),
    importance: normalizeImportance(item.importance, text),
    evidenceType: normalizeEvidenceType(item.evidenceType, text),
  };
}

function splitRequirementChunks(jdText: string): string[] {
  const lines = jdText
    .split(/\r?\n|[。；;]+/)
    .map((line) => line.replace(/^\s*[-*•\d.)、]+\s*/, "").trim())
    .filter((line) => line.length >= 6 && line.length <= 320);
  return unique(lines).slice(0, 18);
}

function extractSkillRequirements(jdText: string): string[] {
  const keywords = extractKeywords(jdText, 40);
  const hardSkills = keywords.filter((keyword) => /^(python|java|javascript|typescript|react|vue|sql|excel|tableau|pytorch|tensorflow|llm|rag|agent|api|docker|github|figma)$/i.test(keyword));
  return hardSkills.map((skill) => `Skill requirement: ${skill}`);
}

function inferCategory(text: string): JDRequirementCategory {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["responsibilities", "responsibility", "负责", "职责", "工作内容"])) return "responsibility";
  if (containsAny(normalized, ["qualification", "required", "requirement", "must", "要求", "必须", "具备"])) return "qualification";
  if (containsAny(normalized, ["skill", "python", "sql", "react", "技能", "熟悉"])) return "skill";
  if (containsAny(normalized, ["preferred", "nice", "plus", "优先", "加分"])) return "nice_to_have";
  return "keyword";
}

function inferImportance(text: string): JDRequirementImportance {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["must", "required", "必须", "至少", "核心", "critical"])) return "critical";
  if (containsAny(normalized, ["responsible", "qualification", "熟悉", "负责", "要求", "highly"])) return "high";
  if (containsAny(normalized, ["preferred", "nice", "plus", "优先", "加分"])) return "medium";
  return "medium";
}

function inferEvidenceType(text: string): JDRequirementEvidenceType {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["python", "sql", "react", "excel", "技能", "熟悉"])) return "keyword_presence";
  if (containsAny(normalized, ["lead", "own", "metric", "increase", "提升", "主导", "指标"])) return "need_user_confirmation";
  return "experience_analogy";
}

function normalizeCategory(value: unknown, text: string): JDRequirementCategory {
  const allowed: JDRequirementCategory[] = ["role_positioning", "responsibility", "qualification", "skill", "keyword", "nice_to_have", "constraint"];
  return allowed.includes(value as JDRequirementCategory) ? value as JDRequirementCategory : inferCategory(text);
}

function normalizeImportance(value: unknown, text: string): JDRequirementImportance {
  const allowed: JDRequirementImportance[] = ["critical", "high", "medium", "low"];
  return allowed.includes(value as JDRequirementImportance) ? value as JDRequirementImportance : inferImportance(text);
}

function normalizeEvidenceType(value: unknown, text: string): JDRequirementEvidenceType {
  const allowed: JDRequirementEvidenceType[] = ["direct_match", "keyword_presence", "experience_analogy", "need_user_confirmation"];
  return allowed.includes(value as JDRequirementEvidenceType) ? value as JDRequirementEvidenceType : inferEvidenceType(text);
}

function uniqueByText<T extends { text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = normalizeText(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(normalizeText(term)));
}
