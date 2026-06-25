type ApiEnvelope<T> = {
  ok: boolean;
  data: T;
  meta?: Record<string, unknown>;
};

type Experience = {
  id: string;
  title: string;
  category?: string;
  organization?: string;
  role?: string;
  content?: string;
};

type MatchResult = {
  experienceId: string;
  title: string;
  matchScore: number;
  matchLevel: "high" | "medium" | "low";
  matchedRequirements?: string[];
  missingRequirements?: string[];
  evidenceFromExperience?: string[];
  reason?: string;
  suggestedUsage?: string;
  rewriteSuggestion?: string;
};

type ToolResultLike = {
  actionResult?: { actionType?: string; status?: string; metadata?: Record<string, unknown> };
  data?: {
    matchMethod?: string;
    jdSummary?: unknown;
    scoreDistribution?: Record<string, number>;
    topResults?: {
      high?: MatchResult[];
      medium?: MatchResult[];
      low?: MatchResult[];
    };
    matchResults?: MatchResult[];
    matches?: MatchResult[];
  };
  summaryFacts?: string[];
  warnings?: string[];
  evidence?: unknown[];
};

type CopilotResponse = {
  sessionId?: string;
  assistantMessage?: { content?: string; metadata?: Record<string, unknown> };
  raw?: {
    toolResults?: ToolResultLike[];
    actionResults?: unknown[];
    agentTrace?: unknown;
    pendingActions?: unknown[];
  };
};

type Scenario = {
  id: "high" | "partial" | "low";
  expected: string;
  jd: string;
};

const BASE_URL = process.env.PHASE1_BASE_URL ?? "http://127.0.0.1:3000";
const USER_ID = process.env.PHASE1_USER_ID ?? "dev-user";

const scenarios: Scenario[] = [
  {
    id: "high",
    expected: "High match: data analyst / BI / SQL role should surface WEEX, AI data processing, and big-data projects.",
    jd: [
      "岗位：数据分析师 / BI Analyst（金融科技）",
      "我们正在寻找一名能够支持交易、用户增长和活动运营的数据分析师。候选人需要熟练使用 SQL 进行多表关联、窗口函数和自动化数据处理，能够搭建 Power BI 或同类 BI 看板，沉淀核心经营指标口径，并围绕用户生命周期、留存、ARPU、入金、交易量等指标进行活动复盘和业务洞察。",
      "加分项包括：有交易所、金融科技或互联网运营分析经验；能与产品、风控、运营团队协作统一指标；具备 Python / Spark / Hadoop 等数据工程能力；能将复杂分析结果转化为业务团队可执行的建议。",
    ].join("\n"),
  },
  {
    id: "partial",
    expected: "Partial match: ML / data engineering internship should match AI, Python, data cleaning, big-data and algorithm projects, but lack production ML training depth.",
    jd: [
      "岗位：机器学习数据工程实习生",
      "团队负责大规模文本、行为和传感器数据的清洗、特征工程与模型训练支持。候选人需要使用 Python 完成数据预处理、异常值处理、标签体系建设和质量评估，并能用 Spark / Hadoop 或类似工具处理较大规模数据。需要理解机器学习基本流程，能配合算法同学准备训练样本、评估数据质量，并撰写清晰的数据处理规范。",
      "加分项：做过语料库治理、用户行为数据分析、时间序列特征、深度学习或多模态传感器项目；有跨团队沟通经验。该岗位不要求独立负责端到端模型上线，但希望有扎实的数据工程与算法协作能力。",
    ].join("\n"),
  },
  {
    id: "low",
    expected: "Low match: luxury retail marketing role should not score technical data/AI projects as high; only leadership/communication should be weakly transferable.",
    jd: [
      "岗位：奢侈品零售门店运营与品牌活动助理",
      "我们希望候选人支持线下精品店日常运营、VIP 客户接待、陈列维护、库存盘点、门店活动执行和品牌社群运营。候选人需要具备零售服务意识、审美判断、客户关系维护能力，能够协助店长完成销售目标跟进、门店培训资料整理和现场活动复盘。",
      "优先考虑有奢侈品、时尚、美妆或高端零售门店实习经验的人选。需要能适应排班、节假日活动和线下客户沟通；该岗位不涉及数据平台开发、算法研发或工程系统建设。",
    ].join("\n"),
  },
];

async function main() {
  const health = await getJson<Record<string, unknown>>("/health", false);
  const experiences = await getJson<Experience[]>("/product/experiences", true);
  const experienceSummary = experiences.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    organization: item.organization,
    role: item.role,
    contentPreview: item.content?.slice(0, 180),
  }));

  const results = [];
  for (const scenario of scenarios) {
    const body = {
      message: [
        "请作为专业招聘顾问，根据下面这份 JD 匹配我现有经历库中最适合的经历。",
        "请输出结构化匹配分析，包括高/中/低匹配、证据、缺口和改写建议。",
        "",
        scenario.jd,
      ].join("\n"),
      jdText: scenario.jd,
      targetRole: scenario.id === "high"
        ? "数据分析师 / BI Analyst"
        : scenario.id === "partial"
          ? "机器学习数据工程实习生"
          : "奢侈品零售门店运营与品牌活动助理",
    };
    const response = await postJson<CopilotResponse>("/copilot/chat", body);
    const matchTool = findMatchTool(response);
    const flattened = flattenMatches(matchTool);
    results.push({
      scenario: scenario.id,
      expected: scenario.expected,
      jd: scenario.jd,
      sessionId: response.sessionId,
      assistantMessage: response.assistantMessage?.content,
      matchMethod: matchTool?.data?.matchMethod,
      scoreDistribution: matchTool?.data?.scoreDistribution,
      jdSummary: matchTool?.data?.jdSummary,
      jdAnalysis: (matchTool?.data as { jdAnalysis?: unknown } | undefined)?.jdAnalysis,
      summaryFacts: matchTool?.summaryFacts,
      warnings: matchTool?.warnings,
      topMatches: flattened.slice(0, 8).map((item) => ({
        title: item.title,
        score: item.matchScore,
        level: item.matchLevel,
        matchedRequirements: item.matchedRequirements?.slice(0, 4) ?? [],
        missingRequirements: item.missingRequirements?.slice(0, 4) ?? [],
        evidence: item.evidenceFromExperience?.slice(0, 3) ?? [],
        reason: item.reason,
        suggestedUsage: item.suggestedUsage,
      })),
      rawMatchCount: flattened.length,
    });
  }

  console.log("PHASE1_JD_MATCH_SMOKE_RESULT_START");
  console.log(JSON.stringify({
    baseUrl: BASE_URL,
    userId: USER_ID,
    health,
    experienceCount: experiences.length,
    experienceSummary,
    results,
  }, null, 2));
  console.log("PHASE1_JD_MATCH_SMOKE_RESULT_END");
}

function findMatchTool(response: CopilotResponse): ToolResultLike | undefined {
  return response.raw?.toolResults?.find((item) => item.actionResult?.actionType === "match_experiences_against_jd");
}

function flattenMatches(result: ToolResultLike | undefined): MatchResult[] {
  const fromMatchResults = result?.data?.matchResults;
  if (Array.isArray(fromMatchResults)) return [...fromMatchResults].sort((a, b) => b.matchScore - a.matchScore);
  const fromMatches = result?.data?.matches;
  if (Array.isArray(fromMatches)) return [...fromMatches].sort((a, b) => b.matchScore - a.matchScore);
  const top = result?.data?.topResults;
  return [
    ...(top?.high ?? []),
    ...(top?.medium ?? []),
    ...(top?.low ?? []),
  ].sort((a, b) => b.matchScore - a.matchScore);
}

async function getJson<T>(path: string, withUser: boolean): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: withUser ? { "x-user-id": USER_ID } : {},
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json() as ApiEnvelope<T>;
  return json.data;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": USER_ID,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json() as ApiEnvelope<T>;
  return json.data;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
