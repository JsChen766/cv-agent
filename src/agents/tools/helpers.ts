import type { RevisionInstruction } from "../../application/revision/index.js";
import type { CopilotWorkspace, ProductVariant } from "../../copilot/types.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";

export function inferTitle(content: string, fallback: string): string {
  return content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 80) ?? fallback;
}

export function ensureWorkspace(sessionId: string, workspace?: CopilotWorkspace | null): CopilotWorkspace {
  return workspace ?? {
    id: `ws-${sessionId}`,
    sessionId,
    variants: [],
    status: "empty",
    updatedAt: new Date().toISOString(),
  };
}

export function markVariantStatus(variants: ProductVariant[], variantId: string, status: ProductVariant["status"]): ProductVariant[] {
  return variants.map((variant) => variant.id === variantId ? { ...variant, status } : variant);
}

export function findArtifact(artifacts: GeneratedArtifact[] | undefined, variantId: string, workspace?: CopilotWorkspace | null): GeneratedArtifact | undefined {
  const workspaceVariant = workspace?.variants.find((item) => item.id === variantId);
  return artifacts?.find((item) => item.id === variantId || item.id === workspaceVariant?.artifactId);
}

export function inferRevisionInstruction(message: string): RevisionInstruction {
  const lower = message.toLowerCase();
  if (lower.includes("quant") || message.includes("量化")) return "make_more_quantified";
  if (lower.includes("unsupported") || message.includes("证据")) return "remove_unsupported_claims";
  return "make_more_conservative";
}
