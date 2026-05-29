import type { ExperienceDraft, ProductExperienceCategory } from "./types.js";

const DATE_SEPARATORS = /[./-]/;
const RANGE_PATTERN = /(?<start>\d{4}(?:[./-]\d{1,2})?)(?:\s*)(?:-|–|—|~|to|至|到)(?:\s*)(?<end>\d{4}(?:[./-]\d{1,2})?|present|current|now|至今|现在)/i;
const SINGLE_DATE_PATTERN = /(?<single>\d{4}(?:[./-]\d{1,2})?)/;

const CATEGORY_KEYWORDS: Record<ProductExperienceCategory, string[]> = {
  work: ["实习", "intern", "工程师", "analyst", "公司", "有限公司", "technology", "exchange", "开发", "数据分析"],
  project: ["项目", "project", "系统", "平台", "开发", "react", "node", "python", "sql", "dashboard"],
  education: ["大学", "学院", "university", "college", "bachelor", "master", "phd", "gpa", "专业", "学位"],
  award: ["奖", "award", "scholarship", "竞赛", "冠军", "获奖"],
  skill: ["技能", "熟悉", "掌握", "熟练", "languages", "frameworks", "tech stack"],
  other: [],
};

const TECH_KEYWORDS = ["react", "vue", "node", "python", "typescript", "javascript", "java", "sql", "aws", "docker", "kubernetes", "power bi", "excel"];

export function extractExperienceDraftFromText(text: string): ExperienceDraft {
  const content = cleanText(text);
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lower = content.toLowerCase();
  const warnings: string[] = [];

  const category = inferCategory(lower);
  const dateRange = extractDateRange(content);
  const tags = extractTags(lower);
  const summary = content.replace(/\s+/g, " ").trim().slice(0, 220);
  const highlights = lines.slice(0, 4);
  const metrics = extractMetrics(content);

  let title = inferTitle(lines, category);
  let organization: string | undefined;
  let role: string | undefined;
  const structured: ExperienceDraft["structured"] = {
    highlights,
    metrics,
    rawText: content,
  };

  if (summary) structured.summary = summary;

  if (category === "education") {
    structured.school = extractSchool(content);
    structured.major = extractLabeledField(content, ["major", "专业"]);
    structured.degree = extractDegree(content);
    structured.gpa = extractGpa(content);
    structured.courses = extractListField(content, ["courses", "课程"]);
    structured.honors = extractListField(content, ["honors", "荣誉"]);
    organization = structured.school;
    if (!structured.school) warnings.push("school_not_found");
    if (!structured.major && !structured.degree) warnings.push("major_or_degree_not_found");
    title = nonEmpty(title, [structured.school, structured.degree, structured.major].filter(Boolean).join(" - "), "Education experience");
  } else if (category === "project") {
    structured.projectName = extractProjectName(content) ?? title;
    structured.projectRole = extractProjectRole(content);
    structured.techStack = tags;
    structured.projectUrl = extractUrl(content);
    organization = extractOrganization(content);
    role = structured.projectRole;
    title = nonEmpty(title, structured.projectName, "Project experience");
    if (!structured.projectName) warnings.push("project_name_not_found");
    if ((structured.techStack?.length ?? 0) === 0) warnings.push("project_tech_stack_not_found");
  } else if (category === "award") {
    structured.issuer = extractOrganization(content);
    structured.awardDate = dateRange.startDate;
    structured.level = extractAwardLevel(content);
    organization = structured.issuer;
    title = nonEmpty(title, extractAwardTitle(content), "Award");
    if (!structured.issuer) warnings.push("award_issuer_not_found");
  } else if (category === "skill") {
    structured.skillCategory = extractLabeledField(content, ["skill category", "技能类别", "skills", "languages", "frameworks"]);
    structured.proficiency = extractProficiency(content);
    structured.evidence = highlights.slice(0, 3);
    title = nonEmpty(title, structured.skillCategory, "Skill");
    if (!structured.skillCategory) warnings.push("skill_category_not_found");
  } else {
    structured.company = extractOrganization(content);
    structured.department = extractLabeledField(content, ["department", "部门"]);
    structured.employmentType = extractEmploymentType(content);
    organization = structured.company;
    role = extractRole(content);
    title = nonEmpty(title, role ? `${role}${organization ? ` - ${organization}` : ""}` : organization, "Work experience");
    if (!organization) warnings.push("organization_not_found");
    if (!role) warnings.push("role_not_found");
  }

  if (!dateRange.startDate && !dateRange.endDate) {
    warnings.push("date_range_not_found");
  }
  if (!title) {
    title = "Untitled experience";
    warnings.push("title_not_found");
  }

  const confidence = computeConfidence({ category, organization, role, dateRangeFound: Boolean(dateRange.startDate || dateRange.endDate), titleFound: Boolean(title), tagsCount: tags.length, warningsCount: warnings.length });

  return {
    category,
    title,
    organization,
    role: role && category !== "education" ? role : undefined,
    startDate: category === "award" ? dateRange.startDate : dateRange.startDate,
    endDate: category === "award" ? undefined : dateRange.endDate,
    content,
    tags,
    structured,
    confidence,
    warnings,
  };
}

function cleanText(text: string): string {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  return normalized.length > 0 ? normalized : "Untitled experience";
}

function inferCategory(lower: string): ProductExperienceCategory {
  const scoreEntries = Object.entries(CATEGORY_KEYWORDS).map(([category, keywords]) => {
    const score = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword.toLowerCase()) ? 1 : 0), 0);
    return [category as ProductExperienceCategory, score] as const;
  });
  scoreEntries.sort((a, b) => b[1] - a[1]);
  const [bestCategory, bestScore] = scoreEntries[0] ?? ["other", 0];
  return bestScore > 0 ? bestCategory : "other";
}

function inferTitle(lines: string[], category: ProductExperienceCategory): string {
  const first = lines.find(Boolean)?.replace(/^[-*]\s*/, "").trim() ?? "";
  if (!first) return "";
  if (category === "project") {
    const match = first.match(/(?:项目|project)[:：\s-]*(.+)$/i);
    if (match?.[1]) return match[1].slice(0, 90).trim();
  }
  return first.slice(0, 90);
}

function extractDateRange(text: string): { startDate?: string; endDate?: string } {
  const range = text.match(RANGE_PATTERN);
  if (range?.groups) {
    return {
      startDate: normalizeDate(range.groups.start),
      endDate: normalizeEndDate(range.groups.end),
    };
  }
  const single = text.match(SINGLE_DATE_PATTERN);
  if (single?.groups?.single) {
    return { startDate: normalizeDate(single.groups.single) };
  }
  return {};
}

function normalizeDate(input?: string): string | undefined {
  if (!input) return undefined;
  const value = input.trim();
  if (/^\d{4}$/.test(value)) return value;
  const [year, month] = value.split(DATE_SEPARATORS);
  if (!year) return undefined;
  if (!month) return year;
  return `${year}-${month.padStart(2, "0")}`;
}

function normalizeEndDate(input?: string): string | undefined {
  if (!input) return undefined;
  const lower = input.trim().toLowerCase();
  if (["present", "current", "now", "至今", "现在"].includes(lower)) return "present";
  return normalizeDate(input);
}

function extractTags(lower: string): string[] {
  const tags = TECH_KEYWORDS
    .filter((keyword) => lower.includes(keyword))
    .map((keyword) => keyword.toLowerCase());
  return Array.from(new Set(tags)).slice(0, 12);
}

function extractMetrics(text: string): Array<{ name: string; value: string; context?: string }> {
  const metrics: Array<{ name: string; value: string; context?: string }> = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|ms|s|秒|分钟|人|次|万|k|m|x|倍)/gi)) {
    metrics.push({
      name: "metric",
      value: `${match[1]}${match[2]}`,
      context: surroundingText(text, match.index ?? 0, 28),
    });
    if (metrics.length >= 8) break;
  }
  return metrics;
}

function surroundingText(text: string, index: number, span: number): string {
  return text.slice(Math.max(0, index - span), Math.min(text.length, index + span)).replace(/\s+/g, " ").trim();
}

function extractOrganization(text: string): string | undefined {
  const direct = text.match(/(?:at|@)\s+([A-Z][A-Za-z0-9&.,\-\s]{1,50})/);
  if (direct?.[1]) return direct[1].trim();

  const chinese = text.match(/在\s*([^\n，。,]{2,40}?)(?:公司|集团|有限公司|科技|大学|学院|担任|任职|实习|工作)/);
  if (chinese?.[1]) return chinese[1].trim();

  const suffix = text.match(/([A-Za-z0-9&.\-\s]{2,50}(?:Inc|LLC|Ltd|Technology|Tech|Company|Exchange))/i);
  if (suffix?.[1]) return suffix[1].trim();
  return undefined;
}

function extractRole(text: string): string | undefined {
  const roleMatch = text.match(/(?:担任|任职|职位|role|position)[:：\s-]*([^\n，。,]{2,40})/i);
  if (roleMatch?.[1]) return roleMatch[1].trim();
  const common = text.match(/\b((?:data|software|frontend|backend|full[- ]stack|ml|ai)\s+(?:analyst|engineer|developer|intern))\b/i);
  if (common?.[1]) return common[1].trim();
  const chinese = text.match(/([^\n，。,]{2,24}(?:工程师|分析师|实习生|经理))/);
  if (chinese?.[1]) return chinese[1].trim();
  return undefined;
}

function extractSchool(text: string): string | undefined {
  const chinese = text.match(/([^\n，。,]{2,50}(?:大学|学院))/);
  if (chinese?.[1]) return chinese[1].trim();
  const english = text.match(/([A-Z][A-Za-z0-9&.\-\s]{2,60}(?:University|College|Institute))/);
  if (english?.[1]) return english[1].trim();
  return undefined;
}

function extractDegree(text: string): string | undefined {
  const match = text.match(/\b(Bachelor(?:'s)?|Master(?:'s)?|PhD|B\.?Sc|M\.?Sc|本科|硕士|博士)\b/i);
  return match?.[1]?.trim();
}

function extractGpa(text: string): string | undefined {
  const match = text.match(/\bGPA[:：\s]*([0-4](?:\.\d{1,2})?)/i);
  return match?.[1];
}

function extractListField(text: string, labels: string[]): string[] | undefined {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(`${escaped}[:：\\s]*([^\\n]+)`, "i");
    const match = text.match(pattern);
    if (match?.[1]) {
      const items = match[1].split(/[、,，/|]/).map((item) => item.trim()).filter(Boolean);
      if (items.length > 0) return items.slice(0, 12);
    }
  }
  return undefined;
}

function extractLabeledField(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(`${escaped}[:：\\s-]*([^\\n]+)`, "i");
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().slice(0, 80);
  }
  return undefined;
}

function extractProjectName(text: string): string | undefined {
  const match = text.match(/(?:项目|project)\s*(?:名称|name)?[:：\s-]*([^\n，。,]{2,80})/i);
  return match?.[1]?.trim();
}

function extractProjectRole(text: string): string | undefined {
  const match = text.match(/(?:项目角色|project role|role)[:：\s-]*([^\n，。,]{2,60})/i);
  return match?.[1]?.trim();
}

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match?.[0];
}

function extractAwardTitle(text: string): string | undefined {
  const match = text.match(/([^\n，。,]{2,80}(?:奖|Award|Scholarship))/i);
  return match?.[1]?.trim();
}

function extractAwardLevel(text: string): string | undefined {
  const match = text.match(/\b(国家级|省级|校级|international|national|regional|first prize|second prize|third prize)\b/i);
  return match?.[1]?.trim();
}

function extractProficiency(text: string): string | undefined {
  const match = text.match(/\b(expert|advanced|intermediate|beginner|熟练|精通|掌握|了解)\b/i);
  return match?.[1]?.trim();
}

function extractEmploymentType(text: string): string | undefined {
  const match = text.match(/\b(full[- ]time|part[- ]time|internship|contract|实习|全职|兼职)\b/i);
  return match?.[1]?.trim();
}

function nonEmpty(primary: string, secondary: string | undefined, fallback: string): string {
  const first = primary.trim();
  if (first) return first;
  const next = secondary?.trim();
  if (next) return next.slice(0, 90);
  return fallback;
}

function computeConfidence(input: {
  category: ProductExperienceCategory;
  organization?: string;
  role?: string;
  dateRangeFound: boolean;
  titleFound: boolean;
  tagsCount: number;
  warningsCount: number;
}): number {
  let score = 0.45;
  if (input.category !== "other") score += 0.15;
  if (input.titleFound) score += 0.1;
  if (input.organization) score += 0.1;
  if (input.role) score += 0.1;
  if (input.dateRangeFound) score += 0.08;
  if (input.tagsCount > 0) score += 0.05;
  score -= Math.min(0.2, input.warningsCount * 0.03);
  return Math.max(0.2, Math.min(0.98, Number(score.toFixed(2))));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
