const ALLOWED_EXPERIENCE_PATCH_KEYS = new Set([
  "title",
  "category",
  "organization",
  "role",
  "tags",
  "status",
  "startDate",
  "endDate",
  "location",
  "description",
  "summary",
]);

export function sanitizeExperiencePatch(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, patchValue] of Object.entries(value)) {
    if (!ALLOWED_EXPERIENCE_PATCH_KEYS.has(key)) continue;
    if (patchValue === undefined || patchValue === null) continue;
    sanitized[key] = patchValue;
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
