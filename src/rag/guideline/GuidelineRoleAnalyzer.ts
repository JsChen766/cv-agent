import type { LLMGuidelineService } from "./LLMGuidelineService.js";
import type { GuidelineRoleAnalysis, GuidelineRoleFamily } from "./types.js";
import { normalizeText, tokenize, unique } from "./textUtils.js";

export class GuidelineRoleAnalyzer {
  public constructor(private readonly llmGuidelineService?: LLMGuidelineService) {}

  public async analyze(input: { jdText: string; targetRole?: string }): Promise<GuidelineRoleAnalysis> {
    const fallback = deterministicAnalyze(input.jdText, input.targetRole);
    if (!this.llmGuidelineService) return fallback;
    try {
      const analyzed = await this.llmGuidelineService.analyzeRole(input);
      return mergeAnalysis(fallback, analyzed);
    } catch (error) {
      if (process.env.DEBUG_GUIDELINE_RAG === "true") {
        console.warn("[GuidelineRoleAnalyzer] LLM analysis failed, using deterministic fallback", error);
      }
      return fallback;
    }
  }
}

export function deterministicAnalyze(jdText: string, targetRole?: string): GuidelineRoleAnalysis {
  const combined = `${targetRole ?? ""}\n${jdText}`;
  const normalized = normalizeText(combined);
  const roleScores = scoreRoleFamilies(normalized);
  const ranked = Object.entries(roleScores).sort((a, b) => b[1] - a[1]) as Array<[GuidelineRoleFamily, number]>;
  const roleFamily = ranked[0]?.[1] > 0 ? ranked[0][0] : "general";
  const secondaryRoleFamilies = ranked.filter(([role, score]) => role !== roleFamily && score >= Math.max(2, ranked[0]?.[1] * 0.55)).slice(0, 2).map(([role]) => role);
  const language = /[\u4e00-\u9fff]/.test(combined) ? "zh" : "en";
  const tokens = tokenize(combined).filter((token) => token.length > 2);
  const priorityRequirements = extractPriorityRequirements(jdText, tokens);
  return {
    roleFamily,
    secondaryRoleFamilies,
    industry: inferIndustry(normalized),
    applicationType: inferApplicationType(normalized),
    language,
    priorityRequirements,
    keywords: unique([...tokens.slice(0, 55), roleFamily, ...secondaryRoleFamilies]).slice(0, 80),
    targetSeniority: inferSeniority(normalized),
    emphasisDimensions: inferEmphasisDimensions(normalized),
  };
}

function mergeAnalysis(fallback: GuidelineRoleAnalysis, analyzed: GuidelineRoleAnalysis): GuidelineRoleAnalysis {
  return {
    roleFamily: analyzed.roleFamily ?? fallback.roleFamily,
    secondaryRoleFamilies: unique([...(analyzed.secondaryRoleFamilies ?? []), ...fallback.secondaryRoleFamilies]).filter((role) => role !== analyzed.roleFamily).slice(0, 3),
    industry: analyzed.industry ?? fallback.industry,
    applicationType: analyzed.applicationType ?? fallback.applicationType,
    language: analyzed.language ?? fallback.language,
    priorityRequirements: unique([...(analyzed.priorityRequirements ?? []), ...fallback.priorityRequirements]).slice(0, 14),
    keywords: unique([...(analyzed.keywords ?? []), ...fallback.keywords]).slice(0, 90),
    targetSeniority: analyzed.targetSeniority ?? fallback.targetSeniority,
    emphasisDimensions: unique([...(analyzed.emphasisDimensions ?? []), ...fallback.emphasisDimensions]).slice(0, 12),
  };
}

function scoreRoleFamilies(text: string): Record<GuidelineRoleFamily, number> {
  const scores: Record<GuidelineRoleFamily, number> = {
    ai_ml: 0,
    software: 0,
    data: 0,
    product: 0,
    research: 0,
    consulting: 0,
    finance: 0,
    general: 0,
  };
  const groups: Array<[GuidelineRoleFamily, RegExp, number]> = [
    ["ai_ml", /\b(llm|vqa|rlhf|aigc|machine learning|deep learning|pytorch|tensorflow|transformer|diffusion|fine tuning|rag|agent)\b|大语言模型|多模态|强化学习|生成式ai|算法工程|人工智能/g, 4],
    ["software", /\b(software|developer|frontend|backend|full stack|system design|api|database|react|java|c\+\+)\b|软件工程|开发工程师|后端|前端|系统设计/g, 3],
    ["data", /\b(data analyst|data scientist|sql|analytics|dashboard|experiment|statistics|bi)\b|数据分析|数据科学|统计|实验设计/g, 3],
    ["product", /\b(product manager|product analyst|user research|roadmap|stakeholder|market analysis)\b|产品经理|用户研究|需求分析|产品分析/g, 3],
    ["research", /\b(research|scientist|publication|paper|patent|cvpr|neurips|iclr|benchmark|ablation|phd)\b|科研|研究员|论文|专利|顶会|博士/g, 3],
    ["consulting", /\b(consult|strategy|case interview|market sizing|client)\b|咨询|战略|案例分析/g, 3],
    ["finance", /\b(finance|investment|quant|bank|valuation|risk model|trading)\b|金融|投资|量化|估值|银行/g, 3],
  ];
  for (const [role, pattern, weight] of groups) {
    scores[role] += (text.match(pattern) ?? []).length * weight;
  }
  if (scores.ai_ml > 0 && scores.research > 0) scores.ai_ml += 2;
  return scores;
}

function inferIndustry(text: string): string | undefined {
  if (/healthcare|medical|hospital|医疗|健康/.test(text)) return "healthcare";
  if (/finance|bank|investment|金融|银行|投资/.test(text)) return "finance";
  if (/education|school|university|教育|学校/.test(text)) return "education";
  if (/ai|machine learning|software|cloud|saas|technology|tech|人工智能|软件|互联网/.test(text)) return "technology";
  return undefined;
}

function inferApplicationType(text: string): GuidelineRoleAnalysis["applicationType"] {
  if (/intern|internship|实习/.test(text)) return "internship";
  if (/master program|graduate program|school application|university application|升学|学校申请|硕士项目/.test(text)) return "school";
  if (/research assistant|research intern|phd|lab|publication|科研申请|博士申请/.test(text)) return "research";
  return "job";
}

function inferSeniority(text: string): GuidelineRoleAnalysis["targetSeniority"] {
  if (/intern|internship|实习/.test(text)) return "intern";
  if (/student|undergraduate|graduate|学生|本科|硕士/.test(text)) return "student";
  if (/senior|lead|principal|manager|staff engineer|高级|负责人/.test(text)) return "experienced";
  if (/junior|entry|new grad|应届|初级/.test(text)) return "junior";
  return "unknown";
}

function inferEmphasisDimensions(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ["technical_depth", /algorithm|architecture|implementation|model|framework|算法|架构|实现|模型/],
    ["research_rigor", /experiment|benchmark|ablation|publication|novelty|实验|基线|消融|论文|创新/],
    ["business_impact", /business|revenue|market|customer|业务|市场|客户|商业/],
    ["user_insight", /user research|user insight|用户研究|用户洞察|需求/],
    ["collaboration", /stakeholder|cross functional|team|协作|跨部门|团队/],
    ["leadership", /lead|manage|mentor|主导|管理|带教/],
    ["deployment", /deploy|production|serving|latency|部署|生产|推理性能/],
    ["communication", /present|write|communication|汇报|表达|沟通/],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function extractPriorityRequirements(jdText: string, tokens: string[]): string[] {
  const lines = jdText
    .split(/\r?\n|[。；;]/)
    .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 6 && line.length <= 260)
    .filter((line) => !/salary|benefit|福利|薪资|导师|人才计划/.test(normalizeText(line)));
  const weighted = lines.map((line) => ({
    line,
    score: (/must|required|任职要求|熟悉|掌握|具备|优先/.test(normalizeText(line)) ? 3 : 0)
      + (/responsib|职责|参与|负责/.test(normalizeText(line)) ? 2 : 0)
      + Math.min(3, (line.match(/\b[A-Z][A-Za-z0-9+.-]+\b/g) ?? []).length),
  })).sort((a, b) => b.score - a.score);
  const selected = unique(weighted.filter((item) => item.score > 0).map((item) => item.line)).slice(0, 12);
  return selected.length > 0 ? selected : tokens.slice(0, 12);
}
