const STOPWORDS = new Set([
  "and", "or", "the", "a", "an", "to", "of", "in", "for", "with", "on", "by", "as", "at", "from",
  "is", "are", "be", "will", "can", "able", "ability", "you", "your", "we", "our", "this", "that",
  "job", "description", "responsibility", "responsibilities", "requirement", "requirements", "preferred", "nice", "have",
  "candidate", "position", "role", "work", "working", "related", "strong", "good", "excellent",
  "岗位", "职位", "详情", "描述", "职责", "工作", "内容", "要求", "任职", "负责", "具备", "相关", "能力", "经验",
  "优先", "熟悉", "了解", "以及", "通过", "核心", "业务", "落地", "优化", "技术", "创新", "背景", "方向", "领域",
  "专业", "项目", "参与", "主导", "进行", "开展", "推动", "结合", "支持", "提供", "具有", "获得", "期间", "包括",
]);

const GENERIC_SKILL_TERMS = new Set([
  "python", "java", "c++", "javascript", "typescript", "sql", "github", "docker", "api", "model", "algorithm",
  "技术", "算法", "模型", "开发", "编程", "代码", "数据", "分析",
]);

const DOMAIN_ALIAS_GROUPS: string[][] = [
  ["llm", "large language model", "large language models", "大语言模型", "大模型"],
  ["vqa", "visual question answering", "视觉问答"],
  ["cv", "computer vision", "计算机视觉"],
  ["rlhf", "reinforcement learning from human feedback", "human feedback alignment", "强化学习", "人类反馈强化学习"],
  ["aigc", "generative ai", "生成式ai", "生成式人工智能"],
  ["ai agent", "agentic ai", "agent", "智能体", "智能代理"],
  ["rag", "retrieval augmented generation", "检索增强生成"],
  ["pytorch", "torch"],
  ["tensorflow", "tf"],
  ["transformer", "transformers"],
  ["diffusion", "diffusion model", "扩散模型"],
  ["fine tuning", "fine-tuning", "finetuning", "微调"],
  ["prompt engineering", "prompt design", "提示词工程", "提示工程"],
  ["multimodal", "multi modal", "多模态"],
  ["recommendation system", "recommender system", "推荐系统"],
  ["reinforcement learning", "rl", "强化学习"],
  ["machine learning", "ml", "机器学习"],
  ["deep learning", "dl", "深度学习"],
  ["natural language processing", "nlp", "自然语言处理"],
  ["speech recognition", "asr", "语音识别"],
  ["user research", "user interview", "用户调研", "用户访谈"],
  ["stakeholder communication", "cross functional collaboration", "跨部门协作", "利益相关者沟通"],
  ["market research", "competitive analysis", "市场调研", "竞品分析"],
  ["data analysis", "analytics", "数据分析"],
  ["cvpr", "iccv", "eccv", "computer vision conference", "视觉顶会"],
  ["neurips", "iclr", "icml", "machine learning conference", "机器学习顶会"],
  ["acl", "emnlp", "naacl", "nlp conference", "自然语言处理顶会"],
  ["kaggle", "kdd cup", "data competition", "算法竞赛", "数据竞赛"],
];

const ALIAS_LOOKUP = buildAliasLookup(DOMAIN_ALIAS_GROUPS);

export function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_/|]+/g, " ")
    .replace(/[^\p{L}\p{N}+#.%\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string | undefined): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const raw = normalized.match(/[\p{L}\p{N}+#.%\-]+/gu) ?? [];
  const tokens = raw
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return unique(tokens.flatMap((token) => expandToken(token)));
}

export function extractKeywords(value: string | undefined, limit = 24): string[] {
  const freq = new Map<string, number>();
  for (const token of tokenize(value)) {
    if (token.length < 2 || isGenericEvidenceTerm(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + termWeight(token));
  }
  for (const alias of expandDomainTerms(value)) {
    freq.set(alias, (freq.get(alias) ?? 0) + termWeight(alias) + 0.5);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, limit);
}

export function extractKeyPhrases(value: string | undefined, limit = 12): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const phrases: string[] = [];
  for (const group of DOMAIN_ALIAS_GROUPS) {
    const hit = group.find((alias) => normalized.includes(normalizeText(alias)));
    if (hit) phrases.push(normalizeText(hit));
  }
  const sourceChunks = (value ?? "")
    .split(/[\n。；;!?！？]+/u)
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 4 && item.length <= 80);
  for (const chunk of sourceChunks) {
    const terms = tokenize(chunk).filter((term) => termWeight(term) >= 0.8);
    if (terms.length >= 2 && terms.length <= 8) phrases.push(terms.join(" "));
  }
  return unique(phrases).slice(0, limit);
}

export function expandDomainTerms(value: string | undefined): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const result: string[] = [];
  for (const [alias, group] of ALIAS_LOOKUP.entries()) {
    if (normalized.includes(alias)) result.push(...group);
  }
  return unique(result.map(normalizeText).filter(Boolean));
}

export function expandQueryTerms(terms: string[]): string[] {
  return unique(terms.flatMap((term) => [normalizeText(term), ...expandDomainTerms(term)]).filter(Boolean));
}

export function scoreTextOverlap(
  queryTerms: string[],
  text: string | undefined,
  options: { documentFrequency?: Map<string, number>; corpusSize?: number } = {},
): { score: number; matchedTerms: string[] } {
  if (queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const expandedTerms = expandQueryTerms(queryTerms).filter((term) => term.length >= 2 && !isGenericEvidenceTerm(term));
  if (expandedTerms.length === 0) return { score: 0, matchedTerms: [] };
  const haystackTokens = new Set(tokenize(text));
  const haystack = normalizeText(text);
  const matchedTerms = unique(expandedTerms.filter((term) => {
    const normalized = normalizeText(term);
    return haystackTokens.has(normalized) || (normalized.length >= 3 && haystack.includes(normalized));
  }));
  const denominator = Math.max(1, totalTermWeight(unique(expandedTerms), options));
  const numerator = totalTermWeight(matchedTerms, options);
  return { score: clamp(numerator / denominator), matchedTerms };
}

export function phraseMatchScore(phrases: string[], text: string | undefined): { score: number; matchedPhrases: string[] } {
  const normalized = normalizeText(text);
  if (!normalized || phrases.length === 0) return { score: 0, matchedPhrases: [] };
  const matched = unique(phrases.map(normalizeText).filter((phrase) => phrase.length >= 3 && normalized.includes(phrase)));
  if (matched.length === 0) return { score: 0, matchedPhrases: [] };
  const weighted = matched.reduce((sum, phrase) => sum + Math.min(2.5, Math.max(1, phrase.split(/\s+/).length * 0.65)), 0);
  return { score: clamp(weighted / Math.max(1, phrases.length * 1.5)), matchedPhrases: matched };
}

export function buildDocumentFrequency(documents: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(tokenize(document))) {
      result.set(term, (result.get(term) ?? 0) + 1);
    }
  }
  return result;
}

export function splitSentences(value: string | undefined, limit = 12): string[] {
  const text = (value ?? "").replace(/\r/g, "").trim();
  if (!text) return [];
  const pieces = text
    .split(/(?<=[。！？!?])\s*|(?<=[.!?])\s+|[\n;；]+|(?:^|\s)[-*•]\s+/u)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 4);
  return unique(pieces).slice(0, limit);
}

export function extractNumbers(value: string | undefined): string[] {
  return unique((value ?? "").match(/\d+(?:\.\d+)?\s*(?:%|％|k|m|万|亿|人|项|篇|次|天|周|月|年)?/gi) ?? [])
    .map((item) => normalizeText(item).replace(/\s+/g, ""));
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

export function safeSlice(value: string | undefined, length: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

export function stringifyStructured(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  const parts: string[] = [];
  visitStructured(value, "", parts, 0);
  return parts.join("\n");
}

export function isGenericEvidenceTerm(term: string): boolean {
  const normalized = normalizeText(term);
  return STOPWORDS.has(normalized)
    || normalized.length < 2
    || (/^[\p{Script=Han}]{2}$/u.test(normalized)
      && ["技术", "业务", "岗位", "职责", "要求", "相关", "经验", "项目", "能力", "创新", "优化", "工作", "专业"].includes(normalized));
}

export function isGenericSkillTerm(term: string): boolean {
  return GENERIC_SKILL_TERMS.has(normalizeText(term));
}

export function termWeight(term: string, options: { documentFrequency?: Map<string, number>; corpusSize?: number } = {}): number {
  const normalized = normalizeText(term);
  if (!normalized) return 0;
  let base = 1;
  if (/^(llm|vqa|rlhf|aigc|rag|pytorch|tensorflow|transformer|diffusion|finetuning|fine-tuning|cvpr|iccv|eccv|neurips|iclr|icml|acl|emnlp|kaggle|kdd cup)$/i.test(normalized)) base = 2.2;
  else if (/大语言模型|大模型|视觉问答|计算机视觉|生成式|智能体|扩散模型|微调|提示词|顶级会议|论文|机器学习|深度学习|多模态/u.test(normalized)) base = 1.8;
  else if (/^(python|java|c\+\+|javascript|typescript|sql|github|docker|api)$/i.test(normalized)) base = 0.7;
  else if (normalized.length <= 2 && !/[+#]/.test(normalized)) base = 0.35;

  const df = options.documentFrequency?.get(normalized);
  const corpusSize = options.corpusSize ?? 0;
  if (df && corpusSize > 1) {
    const idf = Math.log((corpusSize + 1) / (df + 0.5)) + 0.5;
    base *= Math.max(0.45, Math.min(1.8, idf));
  }
  return base;
}

export function canonicalTerm(value: string): string {
  const normalized = normalizeText(value);
  for (const [alias, group] of ALIAS_LOOKUP.entries()) {
    if (normalized === alias || group.includes(normalized)) return group[0];
  }
  return normalized;
}

function totalTermWeight(terms: string[], options: { documentFrequency?: Map<string, number>; corpusSize?: number }): number {
  return terms.reduce((sum, term) => sum + termWeight(term, options), 0);
}

function expandToken(token: string): string[] {
  const items = [token];
  if (/^[\p{Script=Han}]{4,}$/u.test(token)) {
    for (let i = 0; i < token.length - 1; i += 1) items.push(token.slice(i, i + 2));
  }
  return items;
}

function buildAliasLookup(groups: string[][]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const group of groups) {
    const normalizedGroup = unique(group.map(normalizeText).filter(Boolean));
    for (const alias of normalizedGroup) lookup.set(alias, normalizedGroup);
  }
  return lookup;
}

function visitStructured(value: unknown, path: string, parts: string[], depth: number): void {
  if (value == null || depth > 3) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parts.push(path ? `${path}: ${String(value)}` : String(value));
    return;
  }
  if (Array.isArray(value)) {
    const primitives = value.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    if (primitives.length > 0) parts.push(path ? `${path}: ${primitives.join(", ")}` : primitives.join(", "));
    for (const item of value.filter((item) => typeof item === "object" && item !== null).slice(0, 20)) {
      visitStructured(item, path, parts, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visitStructured(child, path ? `${path}.${key}` : key, parts, depth + 1);
    }
  }
}
