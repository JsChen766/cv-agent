const ALLOWED_EXPERIENCE_PATCH_KEYS = new Set([
  "title",
  "category",
  "organization",
  "role",
  "tags",
  "startDate",
  "endDate",
]);

const EXPERIENCE_CATEGORIES = new Set(["work", "project", "education", "award", "skill", "other"]);

export function sanitizeExperiencePatch(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, patchValue] of Object.entries(value)) {
    if (!ALLOWED_EXPERIENCE_PATCH_KEYS.has(key)) continue;
    if (patchValue === undefined || patchValue === null) continue;
    const sanitizedValue = sanitizeExperiencePatchValue(key, patchValue);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

export function hasPatchFields(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeExperiencePatchValue(key: string, value: unknown): unknown {
  if (["title", "organization", "role", "startDate", "endDate"].includes(key)) {
    return stringValue(value);
  }
  if (key === "category") {
    const category = stringValue(value);
    return category && EXPERIENCE_CATEGORIES.has(category) ? category : undefined;
  }
  if (key === "tags") {
    if (!Array.isArray(value)) return undefined;
    const tags = Array.from(new Set(value.map(stringValue).filter((item): item is string => Boolean(item))));
    return tags.length > 0 ? tags.slice(0, 20) : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
