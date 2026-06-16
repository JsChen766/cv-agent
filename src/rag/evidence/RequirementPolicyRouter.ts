import type { JDRequirement, RequirementRetrievalPolicy } from "./types.js";
import { RequirementQueryPlanner } from "./RequirementQueryPlanner.js";
import { normalizeText, unique } from "./textUtils.js";

const HARD_SKILL_TERMS = [
  "python", "java", "c++", "javascript", "typescript", "react", "vue", "sql", "excel", "tableau", "power bi",
  "pytorch", "tensorflow", "llm", "large language model", "rag", "agent", "ai agent", "api", "github", "docker", "kubernetes",
  "vqa", "visual question answering", "cv", "computer vision", "rlhf", "aigc", "transformer", "diffusion", "fine-tuning",
  "prompt engineering", "cvpr", "iccv", "neurips", "iclr", "icml", "acl", "emnlp", "kaggle", "kdd cup",
  "数据分析", "机器学习", "深度学习", "大模型", "大语言模型", "多模态", "计算机视觉", "视觉问答",
  "强化学习", "生成式ai", "智能体", "扩散模型", "微调", "提示词", "算法", "模型", "前端", "后端", "数据库", "可视化",
];

const LEADERSHIP_TERMS = ["lead", "led", "own", "owned", "drive", "drove", "manage", "managed", "leadership", "领导", "主导", "牵头", "负责", "管理"];
const METRIC_TERMS = ["increase", "improve", "reduce", "growth", "revenue", "retention", "conversion", "%", "提升", "增长", "降低", "转化", "留存", "收入", "准确率", "效率"];
const SOFT_SKILL_TERMS = ["communication", "collaboration", "stakeholder", "cross-functional", "research", "analysis", "paper", "publication", "experiment", "competition", "沟通", "协作", "调研", "分析", "需求", "论文", "发表", "实验", "竞赛", "科研"];
const CREDENTIAL_TERMS = ["degree", "phd", "master", "bachelor", "publication", "patent", "award", "conference", "学历", "博士", "硕士", "本科", "论文", "专利", "奖项", "竞赛"];

export class RequirementPolicyRouter {
  private readonly planner = new RequirementQueryPlanner();

  public enrich(requirements: Omit<JDRequirement, "retrievalPolicies" | "keywords" | "coreTerms" | "queryVariants" | "strictness">[]): JDRequirement[] {
    const routed = requirements.map((requirement, index) => ({
      ...requirement,
      id: requirement.id || `req-${index + 1}`,
      retrievalPolicies: this.route(requirement.text),
    }));
    return this.planner.enrich(routed);
  }

  public route(text: string): RequirementRetrievalPolicy[] {
    const normalized = normalizeText(text);
    const policies: RequirementRetrievalPolicy[] = [];
    if (containsAny(normalized, HARD_SKILL_TERMS)) policies.push("keyword_exact", "structured_skill");
    if (containsAny(normalized, SOFT_SKILL_TERMS)) policies.push("semantic_experience", "claim_verification");
    if (containsAny(normalized, CREDENTIAL_TERMS)) policies.push("keyword_exact", "claim_verification");
    if (containsAny(normalized, LEADERSHIP_TERMS) || containsAny(normalized, METRIC_TERMS)) policies.push("claim_verification");
    if (
      containsAny(normalized, ["must", "required", "minimum", "at least", "至少", "必须", "硬性", "需具备"])
      && (containsAny(normalized, LEADERSHIP_TERMS) || containsAny(normalized, METRIC_TERMS) || containsAny(normalized, CREDENTIAL_TERMS))
    ) {
      policies.push("ask_user_required");
    }
    if (policies.length === 0) policies.push("semantic_experience");
    return unique(policies);
  }
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(normalizeText(term)));
}
