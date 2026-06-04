import type { CopilotMessageMetadata, CopilotWorkspace } from "../../copilot/types.js";
import type { ToolResult } from "../tools/ToolResult.js";
import { sanitizeMetadataObject } from "./ProductBlockPresenter.js";

export function mergeWorkspacePatch(results: ToolResult[]): Record<string, unknown> {
  return results
    .filter((result) => result.status === "success")
    .reduce<Record<string, unknown>>((merged, result) => ({ ...merged, ...(result.workspacePatch ?? {}) }), {});
}

export function buildWorkspaceSnapshot(workspace: CopilotWorkspace | null, patch: Record<string, unknown>): CopilotMessageMetadata["workspaceSnapshot"] {
  if (!workspace && Object.keys(patch).length === 0) return undefined;
  const mergedActive = {
    ...(workspace?.active ?? {}),
    ...(isRecord(patch.active) ? patch.active : {}),
  };
  const snapshot = sanitizeMetadataObject({
    activePanel: stringValue(patch.activePanel) ?? workspace?.activePanel,
    active: mergedActive,
    productGenerationId: stringValue(patch.productGenerationId) ?? workspace?.productGenerationId,
    jdId: stringValue(patch.jdId) ?? workspace?.jdId,
    resumeId: stringValue(patch.resumeId) ?? workspace?.resumeId,
    activeVariantId: stringValue(patch.activeVariantId) ?? workspace?.activeVariantId,
    variantCount: Array.isArray(patch.variants) ? patch.variants.length : workspace?.variants.length,
    experienceCount: Array.isArray(patch.experiences) ? patch.experiences.length : workspace?.experiences?.length,
  });
  return snapshot as CopilotMessageMetadata["workspaceSnapshot"] | undefined;
}

export function buildRelatedResourceIds(toolResults: ToolResult[], workspace: CopilotWorkspace | null): NonNullable<CopilotMessageMetadata["relatedResourceIds"]> {
  const experienceIds = new Set<string>();
  const jdIds = new Set<string>();
  const resumeIds = new Set<string>();
  const generationIds = new Set<string>();

  for (const result of toolResults) {
    collectIdsFromUnknown(result.data, { experienceIds, jdIds, resumeIds, generationIds });
    collectIdsFromUnknown(result.actionResult, { experienceIds, jdIds, resumeIds, generationIds });
  }
  if (workspace?.active?.experienceId) experienceIds.add(workspace.active.experienceId);
  if (workspace?.jdId) jdIds.add(workspace.jdId);
  if (workspace?.resumeId) resumeIds.add(workspace.resumeId);
  if (workspace?.productGenerationId) generationIds.add(workspace.productGenerationId);

  return {
    experienceIds: Array.from(experienceIds),
    jdIds: Array.from(jdIds),
    resumeIds: Array.from(resumeIds),
    generationIds: Array.from(generationIds),
  };
}

export function collectIdsFromUnknown(
  value: unknown,
  buckets: {
    experienceIds: Set<string>;
    jdIds: Set<string>;
    resumeIds: Set<string>;
    generationIds: Set<string>;
  },
): void {
  if (!isRecord(value)) return;
  const record = value as Record<string, unknown>;
  addId(buckets.experienceIds, record.experienceId);
  addId(buckets.jdIds, record.jdId);
  addId(buckets.resumeIds, record.resumeId);
  addId(buckets.generationIds, record.generationId);
  if (isRecord(record.experience)) addId(buckets.experienceIds, record.experience.id);
  if (isRecord(record.jd)) addId(buckets.jdIds, record.jd.id);
  if (isRecord(record.resume)) addId(buckets.resumeIds, record.resume.id);
  if (isRecord(record.generation)) addId(buckets.generationIds, record.generation.id);
}

export function addId(set: Set<string>, value: unknown): void {
  const id = stringValue(value);
  if (id) set.add(id);
}

export function hasRelatedResourceIds(value: NonNullable<CopilotMessageMetadata["relatedResourceIds"]>): boolean {
  return (value.experienceIds?.length ?? 0) > 0
    || (value.jdIds?.length ?? 0) > 0
    || (value.resumeIds?.length ?? 0) > 0
    || (value.generationIds?.length ?? 0) > 0;
}

export function updatePendingStatusInProductBlocks(
  blocks: unknown,
  pendingActionId: string,
  status: "confirmed" | "executed" | "cancelled" | "expired" | "failed",
): unknown[] | undefined {
  if (!Array.isArray(blocks)) return undefined;
  return blocks.map((block) => {
    if (!isRecord(block)) return block;

    const payload = isRecord(block.payload) ? block.payload : undefined;
    const payloadAction = isRecord(payload?.action) ? payload.action : undefined;
    if (payloadAction && stringValue(payloadAction.id) === pendingActionId) {
      return {
        ...block,
        payload: {
          ...payload,
          action: {
            ...payloadAction,
            status,
          },
        },
      };
    }

    const data = isRecord(block.data) ? block.data : undefined;
    const dataAction = isRecord(data?.action) ? data.action : undefined;
    if (dataAction && stringValue(dataAction.id) === pendingActionId) {
      return {
        ...block,
        data: {
          ...data,
          action: {
            ...dataAction,
            status,
          },
        },
      };
    }

    return block;
  });
}

export function buildWorkspaceForHistory(
  workspace: CopilotWorkspace | null,
  patch: Record<string, unknown>,
): CopilotWorkspace | undefined {
  if (!workspace) return undefined;
  const mergedActive = {
    ...(workspace.active ?? {}),
    ...(isRecord(patch.active) ? patch.active : {}),
  };
  return {
    ...workspace,
    ...patch,
    active: mergedActive,
    updatedAt: stringValue(patch.updatedAt) ?? workspace.updatedAt,
  } as CopilotWorkspace;
}

// ── Internals ────────────────────────────────────────────────────

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
