import type {
  JDRequirement,
  JDRequirementCategory,
  JDRequirementEvidenceType,
  JDRequirementImportance,
} from "./types.js";
import { RequirementPolicyRouter } from "./RequirementPolicyRouter.js";
import { extractKeywords, normalizeText, unique } from "./textUtils.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";

const SECTION_HEADERS = [
  "职位详情", "核心工作职责", "工作职责", "岗位职责", "职责", "业务落地与优化", "技术创新",
  "任职要求", "岗位要求", "资格要求", "代码及算法能力", "科研/竞赛背景", "加分项", "优先条件",
  "responsibilities", "responsibility", "requirements", "qualifications", "preferred qualifications", "nice to have",
];

export class JDRequirementParser {
  private readonly router = new RequirementPolicyRouter();

  public constructor(private readonly llmEvidenceService?: LLMEvidenceService) {}

  public async parse(input: { jdText: string; targetRole?: string }): Promise<JDRequirement[]> {
    const deterministic = this.parseDeterministic(input.jdText, input.targetRole);
    if (!this.llmEvidenceService) return deterministic;

    try {
      const parsed = await this.llmEvidenceService.parseJDRequirements(input);
      const normalized = parsed
        .flatMap((item, index) => normalizeRequirementOrSplit(item, index))
        .filter((item): item is RequirementBase => Boolean(item));
      const merged = uniqueByMeaning([...normalized, ...deterministic.map(stripRetrievalFields)]);
      const pruned = pruneRequirementSet(merged);
      if (hasUsefulRequirementSet(pruned)) return this.router.enrich(pruned).slice(0, 30);
    } catch (error) {
      if (process.env.DEBUG_EVIDENCE_RAG === "true") {
        console.warn("[JDRequirementParser] LLM parsing failed; using deterministic requirements", error);
      }
    }
    return deterministic;
  }

  private parseDeterministic(jdText: string, targetRole?: string): JDRequirement[] {
    const chunks = splitRequirementChunks(jdText);
    const extracted = chunks
      .map((text, index) => normalizeRequirement({
        text,
        category: inferCategory(text),
        importance: inferImportance(text),
        evidenceType: inferEvidenceType(text),
      }, index))
      .filter((item): item is RequirementBase => Boolean(item));

    const skills = extractSkillRequirements(jdText).map((skill, index) => normalizeRequirement({
      text: skill,
      category: "skill",
      importance: inferSkillImportance(skill, jdText),
      evidenceType: "keyword_presence",
    }, extracted.length + index)).filter((item): item is RequirementBase => Boolean(item));

    const roleRequirement = targetRole?.trim()
      ? normalizeRequirement({
          text: `Target positioning for ${targetRole.trim()}`,
          category: "role_positioning",
          importance: "medium",
          evidenceType: "experience_analogy",
        }, 0)
      : undefined;

    const base = pruneRequirementSet(uniqueByMeaning([
      roleRequirement,
      ...extracted,
      ...skills,
    ].filter((item): item is RequirementBase => Boolean(item))));
    return this.router.enrich(base).slice(0, 30);
  }
}

type RequirementBase = Omit<JDRequirement, "retrievalPolicies" | "keywords" | "coreTerms" | "queryVariants" | "strictness">;

function normalizeRequirementOrSplit(item: Partial<JDRequirement>, index: number): Array<RequirementBase | null> {
  const text = item.text?.trim() ?? "";
  if (text.length > 200 || looksLikeFullJD(text)) {
    return splitRequirementChunks(text).map((chunk, offset) => normalizeRequirement({
      text: chunk,
      category: item.category ?? inferCategory(chunk),
      importance: item.importance ?? inferImportance(chunk),
      evidenceType: item.evidenceType ?? inferEvidenceType(chunk),
    }, index + offset));
  }
  return [normalizeRequirement(item, index)];
}

function normalizeRequirement(item: Partial<JDRequirement>, index: number): RequirementBase | null {
  const text = cleanupRequirementText(item.text);
  if (!text || text.length < 2 || isNonRequirementText(text)) return null;
  return {
    id: item.id?.trim() || `req-${index + 1}`,
    text: text.slice(0, 220),
    category: normalizeCategory(item.category, text),
    importance: normalizeImportance(item.importance, text),
    evidenceType: normalizeEvidenceType(item.evidenceType, text),
  };
}

export function splitRequirementChunks(jdText: string): string[] {
  const headerPattern = new RegExp(`(${SECTION_HEADERS.map(escapeRegex).join("|")})[:：]`, "giu");
  const normalized = (jdText ?? "")
    .replace(/[🎯💡🌟🔥✅●⭐🌞]/g, " ")
    .replace(headerPattern, "\n$1：")
    .replace(/([。；;])\s*/g, "$1\n")
    .replace(/\s*[•·▪◦]\s*/g, "\n")
    .replace(/\s+(?=\d+[.)、])/g, "\n");

  const lines = normalized
    .split(/\r?\n/)
    .flatMap((line) => splitLongClause(line))
    .flatMap((line) => splitEnumeratedSkills(line))
    .map((line) => line.replace(/^\s*[-*•\d.)、]+\s*/, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 240)
    .filter((line) => !isSectionOnly(line))
    .filter((line) => !isNonRequirementText(line))
    .filter((line) => extractKeywords(line, 10).length > 0);

  return uniqueByNormalized(lines).slice(0, 26);
}

function splitLongClause(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.length <= 170) return [trimmed];
  const chunks = trimmed.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  const merged: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    const next = buffer ? `${buffer}，${chunk}` : chunk;
    if (next.length > 150 && buffer) {
      merged.push(buffer);
      buffer = chunk;
    } else {
      buffer = next;
    }
  }
  if (buffer) merged.push(buffer);
  return merged.length > 0 ? merged : [trimmed.slice(0, 220)];
}

function splitEnumeratedSkills(line: string): string[] {
  const normalized = normalizeText(line);
  const skillLike = /熟悉|掌握|experience with|proficient|knowledge of|skills?|技术栈|开发语言|framework/i.test(line);
  if (!skillLike || line.length < 80) return [line];
  const prefixMatch = line.match(/^(.{0,50}?(?:熟悉|掌握|experience with|proficient in|knowledge of|skills? include)[:：]?)/i);
  const prefix = prefixMatch?.[1] ?? "Skill requirement: ";
  const tail = prefixMatch ? line.slice(prefixMatch[0].length) : line;
  const items = tail.split(/[、，,]/).map((item) => item.trim()).filter((item) => item.length >= 2);
  if (items.length < 3) return [line];
  const result = items.map((item) => `${prefix}${item}`.slice(0, 180));
  if (normalized.includes("等") && result.length > 10) return result.slice(0, 10);
  return result.slice(0, 14);
}

function extractSkillRequirements(jdText: string): string[] {
  const keywords = extractKeywords(jdText, 120);
  const hardSkills = keywords.filter((keyword) => /^(python|java|c\+\+|javascript|typescript|react|vue|sql|excel|tableau|power bi|pytorch|tensorflow|llm|large language model|vqa|cv|computer vision|rlhf|aigc|rag|agent|ai agent|api|docker|github|kubernetes|transformer|diffusion|fine tuning|fine-tuning|finetuning|prompt engineering|cvpr|iccv|eccv|neurips|iclr|icml|acl|emnlp|kaggle|kdd cup|大语言模型|大模型|多模态|计算机视觉|视觉问答|强化学习|生成式ai|智能体|扩散模型|微调|提示词|机器学习|深度学习|自然语言处理|推荐系统)$/i.test(keyword));
  return unique(hardSkills).map((skill) => `Skill requirement: ${skill}`);
}

function inferSkillImportance(skill: string, jdText: string): JDRequirementImportance {
  const normalizedSkill = normalizeText(skill.replace(/^Skill requirement:\s*/i, ""));
  const normalizedJD = normalizeText(jdText);
  const requiredPattern = new RegExp(`(?:must|required|必须|熟练掌握|精通)[^。；;]{0,60}${escapeRegex(normalizedSkill)}`, "i");
  return requiredPattern.test(normalizedJD) ? "critical" : "high";
}

function inferCategory(text: string): JDRequirementCategory {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["responsibilities", "responsibility", "负责", "职责", "工作内容", "核心工作", "参与", "推动", "开展"])) return "responsibility";
  if (containsAny(normalized, ["qualification", "required", "requirement", "must", "要求", "必须", "具备", "任职", "学历", "年经验"])) return "qualification";
  if (containsAny(normalized, ["skill", "python", "sql", "react", "pytorch", "tensorflow", "技能", "熟悉", "掌握", "代码", "算法", "框架", "语言"])) return "skill";
  if (containsAny(normalized, ["preferred", "nice", "plus", "优先", "加分", "更佳", "有者优先"])) return "nice_to_have";
  if (containsAny(normalized, ["location", "visa", "work authorization", "地点", "签证", "到岗", "实习时长", "毕业时间"])) return "constraint";
  return "keyword";
}

function inferImportance(text: string): JDRequirementImportance {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["must", "required", "minimum", "at least", "必须", "至少", "硬性", "核心", "critical", "重点", "精通"])) return "critical";
  if (containsAny(normalized, ["responsible", "qualification", "熟练", "负责", "要求", "highly", "具备", "算法", "模型", "发表", "论文"])) return "high";
  if (containsAny(normalized, ["preferred", "nice", "plus", "优先", "加分", "更佳"])) return "medium";
  if (containsAny(normalized, ["bonus", "optional", "可选", "非必须"])) return "low";
  return "medium";
}

function inferEvidenceType(text: string): JDRequirementEvidenceType {
  const normalized = normalizeText(text);
  if (containsAny(normalized, ["python", "sql", "react", "excel", "pytorch", "tensorflow", "llm", "vqa", "rlhf", "技能", "熟悉", "算法", "模型", "学历", "论文", "专利", "奖项"])) return "keyword_presence";
  if (containsAny(normalized, ["lead", "own", "metric", "increase", "improve", "revenue", "提升", "主导", "指标", "负责", "管理", "上线", "增长", "%"])) return "need_user_confirmation";
  if (containsAny(normalized, ["experience in", "experience with", "相关经验", "项目经验", "研究经验"])) return "direct_match";
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

function uniqueByMeaning<T extends { text: string }>(items: T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    const normalized = normalizeText(item.text);
    const duplicate = result.some((existing) => {
      const other = normalizeText(existing.text);
      return normalized === other || (normalized.length > 20 && other.length > 20 && (normalized.includes(other) || other.includes(normalized)));
    });
    if (!duplicate) result.push(item);
  }
  return result;
}

function pruneRequirementSet(requirements: RequirementBase[]): RequirementBase[] {
  const ranked = [...requirements].sort((a, b) => importanceRank(b.importance) - importanceRank(a.importance));
  const result: RequirementBase[] = [];
  const categoryCounts = new Map<JDRequirementCategory, number>();
  for (const requirement of ranked) {
    const maxForCategory = requirement.category === "skill" ? 14 : requirement.category === "nice_to_have" ? 5 : 8;
    const count = categoryCounts.get(requirement.category) ?? 0;
    if (count >= maxForCategory) continue;
    if (requirement.category === "nice_to_have" && result.length >= 22) continue;
    result.push(requirement);
    categoryCounts.set(requirement.category, count + 1);
  }
  return result.sort((a, b) => requirementOrder(a) - requirementOrder(b));
}

function requirementOrder(requirement: RequirementBase): number {
  const categoryOrder: Record<JDRequirementCategory, number> = {
    role_positioning: 0,
    responsibility: 10,
    qualification: 20,
    skill: 30,
    keyword: 40,
    constraint: 50,
    nice_to_have: 60,
  };
  return categoryOrder[requirement.category] - importanceRank(requirement.importance);
}

function importanceRank(value: JDRequirementImportance): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(normalizeText(term)));
}

function cleanupRequirementText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/^[\s\-–—*•\d.)、]+/, "")
    .replace(/^(职位详情|核心工作职责|工作职责|岗位职责|任职要求|岗位要求|资格要求|responsibilities|requirements|qualifications)[:：]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSectionOnly(text: string): boolean {
  const normalized = normalizeText(text.replace(/[：:]/g, ""));
  return SECTION_HEADERS.some((header) => normalizeText(header) === normalized);
}

function isNonRequirementText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (/薪资|福利|导师带教|算力资源|绿色通道|offer|market salary|compensation|benefits/u.test(normalized)) return true;
  if (/公司介绍|团队介绍|about us|what we offer/i.test(normalized)) return true;
  return false;
}

function looksLikeFullJD(text: string): boolean {
  const normalized = normalizeText(text);
  const sectionHits = SECTION_HEADERS.filter((header) => normalized.includes(normalizeText(header))).length;
  return text.length > 260 || sectionHits >= 2;
}

function hasUsefulRequirementSet(items: RequirementBase[]): boolean {
  if (items.length < 2) return false;
  return items.some((item) => item.category === "skill" || item.category === "responsibility" || item.category === "qualification");
}

function stripRetrievalFields(requirement: JDRequirement): RequirementBase {
  return {
    id: requirement.id,
    text: requirement.text,
    category: requirement.category,
    importance: requirement.importance,
    evidenceType: requirement.evidenceType,
  };
}

function uniqueByNormalized(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
