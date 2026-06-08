import type { JDRequirement, RequirementRetrievalPolicy } from "./types.js";
import { extractKeywords, normalizeText, unique } from "./textUtils.js";

const HARD_SKILL_TERMS = [
  "python", "java", "javascript", "typescript", "react", "vue", "sql", "excel", "tableau", "power bi",
  "pytorch", "tensorflow", "llm", "rag", "agent", "api", "github", "docker", "kubernetes",
  "数据分析", "机器学习", "深度学习", "大模型", "前端", "后端", "数据库", "可视化",
];

const LEADERSHIP_TERMS = ["lead", "led", "own", "owned", "drive", "drove", "manage", "managed", "leadership", "领导", "主导", "负责", "管理"];
const METRIC_TERMS = ["increase", "improve", "reduce", "growth", "revenue", "retention", "conversion", "%", "提升", "增长", "降低", "转化", "留存", "收入"];
const SOFT_SKILL_TERMS = ["communication", "collaboration", "stakeholder", "cross-functional", "research", "analysis", "沟通", "协作", "调研", "分析", "需求"];

export class RequirementPolicyRouter {
  public enrich(requirements: Omit<JDRequirement, "retrievalPolicies" | "keywords">[]): JDRequirement[] {
    return requirements.map((requirement, index) => {
      const keywords = extractKeywords(requirement.text, 16);
      return {
        ...requirement,
        id: requirement.id || `req-${index + 1}`,
        keywords,
        retrievalPolicies: this.route(requirement.text),
      };
    });
  }

  public route(text: string): RequirementRetrievalPolicy[] {
    const normalized = normalizeText(text);
    const policies: RequirementRetrievalPolicy[] = [];
    if (containsAny(normalized, HARD_SKILL_TERMS)) policies.push("keyword_exact", "structured_skill");
    if (containsAny(normalized, SOFT_SKILL_TERMS)) policies.push("semantic_experience", "claim_verification");
    if (containsAny(normalized, LEADERSHIP_TERMS) || containsAny(normalized, METRIC_TERMS)) policies.push("claim_verification");
    if (containsAny(normalized, ["must", "required", "至少", "必须"]) && (containsAny(normalized, LEADERSHIP_TERMS) || containsAny(normalized, METRIC_TERMS))) {
      policies.push("ask_user_required");
    }
    if (policies.length === 0) policies.push("semantic_experience");
    return unique(policies);
  }
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(normalizeText(term)));
}
