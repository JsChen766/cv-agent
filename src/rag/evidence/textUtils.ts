const STOPWORDS = new Set([
  "and", "or", "the", "a", "an", "to", "of", "in", "for", "with", "on", "by", "as", "at", "from",
  "is", "are", "be", "will", "can", "able", "ability", "you", "your", "we", "our", "this", "that",
  "job", "description", "responsibility", "responsibilities", "requirement", "requirements", "preferred", "nice", "have",
  "岗位", "职位", "详情", "描述", "职责", "工作", "内容", "要求", "任职", "负责", "具备", "相关", "能力", "经验",
  "优先", "熟悉", "了解", "以及", "通过", "核心", "业务", "落地", "优化", "技术", "创新", "背景", "方向", "领域",
  "专业", "项目", "参与", "主导", "进行", "开展", "推动", "结合", "支持", "提供", "具有", "获得", "期间", "包括",
]);

const DOMAIN_ALIASES: Array<[RegExp, string[]]> = [
  [/\bllms?\b/i, ["llm", "large language model", "大语言模型", "大模型"]],
  [/大语言模型|大模型/u, ["llm", "large language model", "大语言模型", "大模型"]],
  [/\bvqa\b/i, ["vqa", "visual question answering", "视觉问答"]],
  [/视觉问答/u, ["vqa", "visual question answering", "视觉问答"]],
  [/\bcv\b|computer vision/i, ["cv", "computer vision", "计算机视觉"]],
  [/计算机视觉/u, ["cv", "computer vision", "计算机视觉"]],
  [/\brlhf\b/i, ["rlhf", "reinforcement learning from human feedback", "强化学习"]],
  [/强化学习/u, ["rlhf", "reinforcement learning", "强化学习"]],
  [/\baigc\b/i, ["aigc", "generative ai", "生成式ai", "生成式人工智能"]],
  [/生成式/u, ["aigc", "generative ai", "生成式ai", "生成式人工智能"]],
  [/ai\s*agent|agentic/i, ["ai agent", "agent", "智能体"]],
  [/智能体/u, ["ai agent", "agent", "智能体"]],
  [/pytorch/i, ["pytorch"]],
  [/tensorflow/i, ["tensorflow"]],
  [/transformer/i, ["transformer"]],
  [/diffusion/i, ["diffusion", "扩散模型"]],
  [/扩散模型/u, ["diffusion", "扩散模型"]],
  [/fine[-\s]?tuning/i, ["fine-tuning", "finetuning", "微调"]],
  [/微调/u, ["fine-tuning", "finetuning", "微调"]],
  [/prompt engineering/i, ["prompt engineering", "提示词工程"]],
  [/提示词/u, ["prompt engineering", "提示词工程"]],
  [/cvpr|iccv|neurips|iclr|aaai|acl|emnlp/i, ["cvpr", "iccv", "neurips", "iclr", "top conference", "顶级会议", "论文"]],
  [/顶级会议|论文发表|发表论文/u, ["top conference", "顶级会议", "论文", "发表"]],
  [/kaggle|kdd cup/i, ["kaggle", "kdd cup", "competition", "竞赛"]],
  [/算法|模型|深度学习|机器学习/u, ["algorithm", "model", "deep learning", "machine learning", "算法", "模型", "深度学习", "机器学习"]],
];

export function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
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
  for (const alias of extractDomainAliases(value)) {
    freq.set(alias, (freq.get(alias) ?? 0) + termWeight(alias) + 0.5);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, limit);
}

export function scoreTextOverlap(queryTerms: string[], text: string | undefined): { score: number; matchedTerms: string[] } {
  if (queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const expandedTerms = expandQueryTerms(queryTerms).filter((term) => term.length >= 2 && !isGenericEvidenceTerm(term));
  if (expandedTerms.length === 0) return { score: 0, matchedTerms: [] };
  const haystackTokens = new Set(tokenize(text));
  const haystack = normalizeText(text);
  const matchedTerms = unique(expandedTerms.filter((term) => {
    const normalized = normalizeText(term);
    return haystackTokens.has(normalized) || (normalized.length >= 3 && haystack.includes(normalized));
  }));
  const denominator = Math.max(1, Math.min(totalTermWeight(unique(expandedTerms)), 12));
  const numerator = totalTermWeight(matchedTerms);
  return { score: clamp(numerator / denominator), matchedTerms };
}

export function splitSentences(value: string | undefined, limit = 12): string[] {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const pieces = text
    .split(/(?<=[。！？.!?])\s+|[\n;；]+|(?:^|\s)[-*•]\s+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
  return unique(pieces).slice(0, limit);
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

export function safeSlice(value: string | undefined, length: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

export function stringifyStructured(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      parts.push(`${key}: ${String(raw)}`);
    } else if (Array.isArray(raw)) {
      parts.push(`${key}: ${raw.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", ")}`);
    }
  }
  return parts.join("\n");
}

export function isGenericEvidenceTerm(term: string): boolean {
  const normalized = normalizeText(term);
  return STOPWORDS.has(normalized)
    || normalized.length < 2
    || /^[\p{Script=Han}]{2}$/u.test(normalized) && ["技术", "业务", "岗位", "职责", "要求", "相关", "经验", "项目", "能力", "创新", "优化"].includes(normalized);
}

export function termWeight(term: string): number {
  const normalized = normalizeText(term);
  if (!normalized) return 0;
  if (/^(llm|vqa|rlhf|aigc|rag|pytorch|tensorflow|transformer|diffusion|finetuning|fine-tuning|cvpr|iccv|neurips|iclr|kaggle|kdd cup)$/i.test(normalized)) return 2.2;
  if (/大语言模型|大模型|视觉问答|计算机视觉|强化学习|生成式|智能体|扩散模型|微调|提示词|顶级会议|论文|算法|模型|机器学习|深度学习/u.test(normalized)) return 1.8;
  if (/^(python|java|c\+\+|javascript|typescript|sql|github|docker)$/i.test(normalized)) return 0.9;
  if (normalized.length <= 2 && !/[+#]/.test(normalized)) return 0.35;
  return 1;
}

function totalTermWeight(terms: string[]): number {
  return terms.reduce((sum, term) => sum + termWeight(term), 0);
}

function expandQueryTerms(terms: string[]): string[] {
  return unique(terms.flatMap((term) => [term, ...extractDomainAliases(term)]));
}

function extractDomainAliases(value: string | undefined): string[] {
  const text = value ?? "";
  const aliases: string[] = [];
  for (const [pattern, expanded] of DOMAIN_ALIASES) {
    if (pattern.test(text)) aliases.push(...expanded);
  }
  return unique(aliases.map((item) => normalizeText(item)).filter(Boolean));
}

function expandToken(token: string): string[] {
  const items = [token];
  if (/^[\p{Script=Han}]{4,}$/u.test(token)) {
    for (let i = 0; i < token.length - 1; i += 1) items.push(token.slice(i, i + 2));
  }
  return items;
}
