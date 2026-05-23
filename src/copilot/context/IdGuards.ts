const CANONICAL_PREFIXES = [
  "pexp-",
  "pjd-",
  "pres-",
  "presitem-",
  "pvar-",
  "pexpvar-",
  "pgen-",
  "pgenvar-",
  "pexprev-",
  "pimp-",
  "pimpcand-",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalExperienceId(value: unknown): value is string {
  return isCanonicalId(value, "pexp-");
}

export function isCanonicalJDId(value: unknown): value is string {
  return isCanonicalId(value, "pjd-");
}

export function isCanonicalResumeId(value: unknown): value is string {
  return isCanonicalId(value, "pres-");
}

export function isCanonicalVariantId(value: unknown): value is string {
  return typeof value === "string" && (isCanonicalId(value, "pvar-") || isCanonicalId(value, "pexpvar-"));
}

export function isCanonicalGenerationId(value: unknown): value is string {
  return isCanonicalId(value, "pgen-");
}

function isCanonicalId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(prefix) && UUID_RE.test(value.slice(prefix.length));
}

export function isAnyCanonicalAssetId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_PREFIXES.some((prefix) => value.startsWith(prefix) && UUID_RE.test(value.slice(prefix.length)));
}

export function guardExperienceId(value: unknown): { valid: true; id: string } | { valid: false; reason: string } {
  if (!value) return { valid: false, reason: "请先选择一条经历，或让我先搜索相关经历。" };
  if (isCanonicalExperienceId(value)) return { valid: true, id: value };
  return { valid: false, reason: "我需要先确认你指的是哪条经历，请从经历库中选择，或让我先搜索相关经历。" };
}

export function guardJDId(value: unknown): { valid: true; id: string } | { valid: false; reason: string } {
  if (!value) return { valid: false, reason: "请先选择一份 JD，或让我先搜索相关 JD。" };
  if (isCanonicalJDId(value)) return { valid: true, id: value };
  return { valid: false, reason: "我需要先确认你指的是哪份 JD，请从 JD 库中选择，或让我先搜索相关 JD。" };
}

export function guardResumeId(value: unknown): { valid: true; id: string } | { valid: false; reason: string } {
  if (!value) return { valid: false, reason: "请先选择一份简历。" };
  if (isCanonicalResumeId(value)) return { valid: true, id: value };
  return { valid: false, reason: "我需要先确认你指的是哪份简历，请从简历库中选择。" };
}

export function sanitizeOrRejectExperienceId(value: unknown): string | undefined {
  return isCanonicalExperienceId(value) ? value : undefined;
}

export function sanitizeOrRejectJDId(value: unknown): string | undefined {
  return isCanonicalJDId(value) ? value : undefined;
}

export function sanitizeOrRejectResumeId(value: unknown): string | undefined {
  return isCanonicalResumeId(value) ? value : undefined;
}
