import type { LLMGuidelineService } from "./LLMGuidelineService.js";
import type { GuidelineRoleAnalysis } from "./types.js";
import { normalizeText, tokenize, unique } from "./textUtils.js";

export class GuidelineRoleAnalyzer {
  public constructor(private readonly llmGuidelineService?: LLMGuidelineService) {}

  public async analyze(input: {
    jdText: string;
    targetRole?: string;
  }): Promise<GuidelineRoleAnalysis> {
    if (this.llmGuidelineService) {
      try {
        const analyzed = await this.llmGuidelineService.analyzeRole(input);
        if (analyzed.priorityRequirements.length > 0 || analyzed.keywords.length > 0) return analyzed;
      } catch (error) {
        if (process.env.DEBUG_GUIDELINE_RAG === "true") {
          console.warn("[GuidelineRoleAnalyzer] LLM analysis failed, using deterministic fallback", error);
        }
      }
    }
    return deterministicAnalyze(input.jdText, input.targetRole);
  }
}

export function deterministicAnalyze(jdText: string, targetRole?: string): GuidelineRoleAnalysis {
  const combined = `${targetRole ?? ""}\n${jdText}`;
  const normalized = normalizeText(combined);
  const roleFamily = inferRoleFamily(normalized);
  const applicationType = inferApplicationType(normalized);
  const language = /[\u4e00-\u9fff]/.test(combined) ? "zh" : "en";
  const tokens = tokenize(combined).filter((token) => token.length > 2);
  const priorityRequirements = extractPriorityRequirements(jdText, tokens);
  return {
    roleFamily,
    industry: inferIndustry(normalized),
    applicationType,
    language,
    priorityRequirements,
    keywords: unique([...tokens.slice(0, 40), ...(roleFamily ? [roleFamily] : [])]).slice(0, 60),
    targetSeniority: inferSeniority(normalized),
  };
}

function inferRoleFamily(text: string): string | undefined {
  if (/product|用户|产品|pm\b|product manager|product analyst/.test(text)) return "product";
  if (/software|engineer|developer|frontend|backend|full stack|react|java|python|工程师|开发/.test(text)) return "software";
  if (/research|scientist|phd|publication|论文|研究/.test(text)) return "research";
  if (/consult|strategy|case|咨询|战略/.test(text)) return "consulting";
  if (/finance|investment|quant|bank|金融|投资|量化/.test(text)) return "finance";
  return undefined;
}

function inferIndustry(text: string): string | undefined {
  if (/ai|machine learning|llm|software|cloud|saas|technology|tech|人工智能|软件/.test(text)) return "technology";
  if (/finance|bank|investment|金融|银行|投资/.test(text)) return "finance";
  if (/education|school|university|教育|学校/.test(text)) return "education";
  return undefined;
}

function inferApplicationType(text: string): GuidelineRoleAnalysis["applicationType"] {
  if (/school|university|master|phd|program|申请|学校|项目/.test(text)) return "school";
  if (/intern|internship|实习/.test(text)) return "internship";
  if (/research|lab|publication|研究/.test(text)) return "research";
  return "job";
}

function inferSeniority(text: string): GuidelineRoleAnalysis["targetSeniority"] {
  if (/intern|internship|实习/.test(text)) return "intern";
  if (/student|undergraduate|graduate|学生|本科|硕士/.test(text)) return "student";
  if (/senior|lead|principal|manager/.test(text)) return "experienced";
  if (/junior|entry|new grad/.test(text)) return "junior";
  return "unknown";
}

function extractPriorityRequirements(jdText: string, tokens: string[]): string[] {
  const lines = jdText.split(/\r?\n|[。；;]/).map((line) => line.trim()).filter(Boolean);
  const requirementLines = lines
    .filter((line) => /require|responsib|qualif|must|preferred|experience|skill|要求|职责|经验|能力|熟悉|掌握/i.test(line))
    .slice(0, 8);
  if (requirementLines.length > 0) return requirementLines.map((line) => line.slice(0, 180));
  return tokens.slice(0, 10);
}
