import type { ExperienceDraft, NormalizedExperiencePreview, ProductExperience, ProductExperienceCategory } from "./types.js";

export function buildNormalizedExperiencePreview(
  draft: ExperienceDraft,
  options: { id?: string; missingFields?: string[] } = {},
): NormalizedExperiencePreview {
  const structured = draft.structured || {};
  const category = normalizeCategory(draft.category, draft);
  const organization = firstString(draft.organization, structured.company, structured.school, structured.issuer);
  const role = firstString(draft.role, structured.projectRole);
  const description = firstString(
    draft.content,
    structured.summary,
    joinLines(draft.structured?.highlights || []),
  );
  const skills = uniqueStrings([
    ...(draft.tags || []),
    ...(Array.isArray(structured.techStack) ? structured.techStack : []),
  ]);
  const highlights = uniqueStrings(draft.structured?.highlights || []);

  return {
    id: options.id,
    category,
    title: firstString(draft.title, structured.projectName, `${role || ""} ${organization || ""}`.trim(), "经历草稿"),
    organization: organization || undefined,
    role: role || undefined,
    startDate: firstString(draft.startDate, (structured as Record<string, unknown>).startDate, structured.awardDate),
    endDate: draft.endDate,
    location: firstString((structured as Record<string, unknown>).location),
    description: description || undefined,
    highlights,
    skills,
    rawText: firstString(structured.rawText, draft.content),
    confidence: typeof draft.confidence === "number" ? draft.confidence : undefined,
    missingFields: options.missingFields && options.missingFields.length ? options.missingFields : draft.warnings,
  };
}

export function previewFromExperience(
  experience: ProductExperience & { content?: string; structured?: Record<string, unknown> },
): NormalizedExperiencePreview {
  const structured = experience.structured || {};
  return {
    id: experience.id,
    category: normalizeCategory(experience.category),
    title: experience.title,
    organization: experience.organization,
    role: experience.role,
    startDate: experience.startDate,
    endDate: experience.endDate,
    location: firstString(structured.location),
    description: firstString(experience.content, structured.summary),
    highlights: uniqueStrings(Array.isArray(structured.highlights) ? structured.highlights : []),
    skills: uniqueStrings([
      ...(Array.isArray(experience.tags) ? experience.tags : []),
      ...(Array.isArray(structured.techStack) ? structured.techStack : []),
    ]),
    rawText: firstString(structured.rawText),
    missingFields: [],
  };
}

function normalizeCategory(value: unknown, draft?: ExperienceDraft): ProductExperienceCategory {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("intern")) return "internship";
  if (raw === "work" || raw.includes("work")) {
    if (draft && /intern|实习/i.test(`${draft.title} ${draft.role} ${draft.content}`)) return "internship";
    return "work";
  }
  if (raw.includes("education")) return "education";
  if (raw.includes("project")) return "project";
  if (raw.includes("award")) return "award";
  if (raw.includes("skill")) return "skill";
  return "other";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function joinLines(values: string[]) {
  return values.filter(Boolean).slice(0, 3).join("\n");
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output.slice(0, 12);
}
