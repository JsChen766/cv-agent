import type { JDRequirement, JDRequirementCategory, JDRequirementEvidenceType, JDRequirementImportance } from "./types.js";
import { RequirementPolicyRouter } from "./RequirementPolicyRouter.js";
import { extractKeywords, normalizeText, unique } from "./textUtils.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";

export class JDRequirementParser {
  private readonly router = new RequirementPolicyRouter();

  public constructor(private readonly llmEvidenceService?: LLMEvidenceService) {}

  public async parse(input: { jdText: string; targetRole?: string }): Promise<JDRequirement[]> {
    const deterministic = this.parseDeterministic(input.jdText, input.targetRole);
    if (this.llmEvidenceService) {
      try {
        const parsed = await this.llmEvidenceService.parseJDRequirements(input);
        const normalized = parsed
          .flatMap((item, index) => normalizeRequirementOrSplit(item, index))
          .filter((item): item is Omit<JDRequirement, "retrievalPolicies" | "keywords"> => Boolean(item));
        const merged = uniqueByText([...normalized, ...deterministic.map(stripRetrievalFields)]);
        if (hasUsefulRequirementSet(merged)) return this.router.enrich(merged).slice(0, 28);
      } catch {
        // Fall through to deterministic parsing. Evidence RAG should never block generation only because JD parsing failed.
      }
    }
    return deterministic;
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
    return this.router.enrich(base).slice(0, 28);
  }
}

function normalizeRequirementOrSplit(item: Partial<JDRequirement>, index: number): Array<Omit<JDRequirement, "retrievalPolicies" | "keywords"> | null> {
  const text = item.text?.trim() ?? "";
  if (text.length > 220 || looksLikeFullJD(text)) {
    return splitRequirementChunks(text).map((chunk, offset) => normalizeRequirement({
      text: chunk,
      category: item.category ?? inferCategory(chunk),
      importance: item.importance ?? inferImportance(chunk),
      evidenceType: item.evidenceType ?? inferEvidenceType(chunk),
    }, index + offset));
  }
  return [normalizeRequirement(item, index)];
}

function normalizeRequirement(item: Partial<JDRequirement>, index: number): Omit<JDRequirement, "retrievalPolicies" | "keywords"> | null {
  const text = cleanupRequirementText(item.text);
  if (!text || text.length < 2) return null;
  return {
    id: item.id?.trim() || `req-${index + 1}`,
    text: text.slice(0, 220),
    category: normalizeCategory(item.category, text),
    importance: normalizeImportance(item.importance, text),
    evidenceType: normalizeEvidenceType(item.evidenceType, text),
  };
}

function splitRequirementChunks(jdText: string): string[] {
  const normalized = (jdText ?? "")
    .replace(/[🎯💡🌟🔥✅●]/g, " ")
    .replace(/(职位详情|核心工作职责|业务落地与优化|技术创新|任职要求|代码及算法能力|科研\/竞赛背景|专属福利|招聘绿色通道)[:：]/g, "\n$1：")
    .replace(/([。；;])\s*/g, "$1\n");
  const lines = normalized
    .split(/\r?\n/)
    .flatMap((line) => splitLongClause(line))
    .map((line) => line.replace(/^\s*[-*•\d.)、]+\s*/, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 260)
    .filter((line) => extractKeywords(line, 8).length > 0);
  return unique(lines).slice(0, 22);
}

function splitLongClause(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.length <= 220) return [trimmed];
  const chunks = trimmed.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  const merged: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    const next = buffer ? `${buffer}，${chunk}` : chunk;
    if (next.length > 180 && buffer) {
      merged.push(buffer);
      buffer = chunk;
    } else {
      buffer = next;
    }
  }
  if (buffer) merged.push(buffer);
  return merged.length > 0 ? merged : [trimmed.slice(0, 220)];
}

function extractSkillRequirements(jdText: string): string[] {
  const keywords = extractKeywords(jdText, 80);
  const hardSkills = keywords.filter((keyword) => /^(python|java|c\+\+|javascript|typescript|react|vue|sql|excel|tableau|pytorch|tensorflow|llm|large language model|vqa|cv|computer vision|rlhf|aigc|rag|agent|ai agent|api|docker|github|transformer|diffusion|fine-tuning|finetuning|prompt engineering|cvpr|iccv|neurips|iclr|kaggle|kdd cup|大语言模型|大模型|多模态|计算机视觉|视觉问答|强化学习|生成式ai|智能体|扩散模型|微调|提示词|算法|模型|机器学习|深度学习|论文)$/i.test(keyword));
  return unique(hardSkills).map((skill) => `Skill requirement: ${skill}`);
}

function inferCategory(text: string): JDRequirementCategory {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["responsibilities", "responsibility", "负责", "职责", "工作内容", "核心工作"])) return "responsibility";
  if (containsAny(normalized, ["qualification", "required", "requirement", "must", "要求", "必须", "具备", "任职"])) return "qualification";
  if (containsAny(normalized, ["skill", "python", "sql", "react", "pytorch", "tensorflow", "技能", "熟悉", "掌握", "代码", "算法"])) return "skill";
  if (containsAny(normalized, ["preferred", "nice", "plus", "优先", "加分", "福利", "绿色通道"])) return "nice_to_have";
  return "keyword";
}

function inferImportance(text: string): JDRequirementImportance {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["must", "required", "必须", "至少", "核心", "critical", "重点"])) return "critical";
  if (containsAny(normalized, ["responsible", "qualification", "熟悉", "负责", "要求", "highly", "具备", "算法", "模型"])) return "high";
  if (containsAny(normalized, ["preferred", "nice", "plus", "优先", "加分", "福利"])) return "medium";
  return "medium";
}

function inferEvidenceType(text: string): JDRequirementEvidenceType {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["python", "sql", "react", "excel", "pytorch", "tensorflow", "llm", "vqa", "rlhf", "技能", "熟悉", "算法", "模型"])) return "keyword_presence";
  if (containsAny(normalized, ["lead", "own", "metric", "increase", "提升", "主导", "指标", "负责"])) return "need_user_confirmation";
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

function cleanupRequirementText(value: string | undefined): string {
  return (value ?? "")
    .replace(/[🎯💡🌟🔥✅●]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeFullJD(text: string): boolean {
  const normalized = normalizeText(text);
  const markers = ["职位详情", "核心工作职责", "任职要求", "科研", "招聘", "福利", "job description", "responsibilities", "requirements"];
  return text.length > 320 || markers.filter((marker) => normalized.includes(normalizeText(marker))).length >= 2;
}

function hasUsefulRequirementSet(items: Array<Omit<JDRequirement, "retrievalPolicies" | "keywords">>): boolean {
  if (items.length >= 3) return true;
  return items.some((item) => item.text.length < 220 && extractKeywords(item.text, 8).length >= 2);
}

function stripRetrievalFields(requirement: JDRequirement): Omit<JDRequirement, "retrievalPolicies" | "keywords"> {
  return {
    id: requirement.id,
    text: requirement.text,
    category: requirement.category,
    importance: requirement.importance,
    evidenceType: requirement.evidenceType,
  };
}
