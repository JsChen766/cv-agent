import type { ApiKernel } from "../../types.js";
import { toWorkspaceVariant } from "../../../agent-tools/resume/index.js";
import type { ProductGeneratedVariant, ProductGeneration } from "../../../product/types.js";

export function extractVariantsFromOutputSnapshot(
  outputSnapshot: ProductGeneration["outputSnapshot"],
): ProductGeneratedVariant[] {
  if (!outputSnapshot) return [];
  const paths = [
    outputSnapshot.variants,
    (outputSnapshot.result as Record<string, unknown> | undefined)?.variants,
    (outputSnapshot.data as Record<string, unknown> | undefined)?.variants,
    outputSnapshot.resumeVariants,
    outputSnapshot.generatedVariants,
  ];
  for (const candidate of paths) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.filter(isValidVariant) as ProductGeneratedVariant[];
    }
  }
  return findVariantsRecursive(outputSnapshot);
}

export function findVariantsRecursive(obj: unknown): ProductGeneratedVariant[] {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every((item) => isValidRecord(item) && typeof (item as Record<string, unknown>).id === "string" && typeof (item as Record<string, unknown>).content === "string")) {
      return obj as ProductGeneratedVariant[];
    }
    return obj.flatMap(findVariantsRecursive);
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (key.endsWith("variants") || key.endsWith("Variants")) {
      const value = (obj as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.filter(isValidVariant) as ProductGeneratedVariant[];
    }
  }
  for (const value of Object.values(obj as Record<string, unknown>)) {
    const found = findVariantsRecursive(value);
    if (found.length > 0) return found;
  }
  return [];
}

function isValidVariant(item: unknown): boolean {
  return (
    isValidRecord(item) &&
    typeof (item as Record<string, unknown>).id === "string" &&
    typeof (item as Record<string, unknown>).content === "string" &&
    !!(item as Record<string, unknown>).id
  );
}

function isValidRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function convertToWorkspaceVariants(
  raw: ProductGeneratedVariant[],
  generation: ProductGeneration,
  userId: string,
  kernel: ApiKernel,
): Promise<ReturnType<typeof toWorkspaceVariant>[]> {
  if (raw.length === 0) return [];
  let jd = generation.jdId ? await kernel.productServices.jdService.getJD(userId, generation.jdId) : null;
  if (!jd && raw.length > 0) {
    jd = {
      id: generation.jdId ?? "unknown",
      userId,
      title: generation.targetRole ?? "Untitled JD",
      company: undefined,
      targetRole: generation.targetRole,
      rawText: "",
      createdAt: generation.createdAt,
      updatedAt: generation.createdAt,
    };
  }
  return raw.map((variant, index) => toWorkspaceVariant(variant, jd!, generation.id, index));
}
