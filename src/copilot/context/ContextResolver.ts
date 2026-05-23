import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";
import { activeExperienceText, activeJDText, activeResumeItemText } from "./ActiveAssetResolver.js";
import { mostRecentExperienceDraft, mostRecentJDDraft, mostRecentResumeDraft } from "./DraftContext.js";

export type ResolverRunContext = Pick<AgentContext, "clientState" | "activeAssetContext" | "productContext" | "userMessage"> & {
  requestJDText?: string;
};

export type ResolvedAsset = {
  id?: string;
  draftId?: string;
  text?: string;
  targetRole?: string;
  source?: string;
};

export class ContextResolver {
  public resolveJD(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const draft = mostRecentJDDraft(workspace);
    const explicitText = stringValue(explicitArgs.jdText) ?? stringValue(explicitArgs.text);
    const id =
      stringValue(explicitArgs.jdId)
      ?? stringValue(explicitArgs.id)
      ?? context.clientState?.activeJDId
      ?? workspace?.active?.jdId
      ?? workspace?.jdId
      ?? handoff?.extracted.jdId
      ?? context.activeAssetContext?.activeJD?.id;
    const text =
      explicitText
      ?? context.requestJDText
      ?? handoff?.extracted.jdText
      ?? draft?.rawText
      ?? activeJDText(context.activeAssetContext);
    return {
      id,
      draftId: workspace?.active?.jdDraftId ?? draft?.id,
      text,
      targetRole: stringValue(explicitArgs.targetRole) ?? handoff?.extracted.targetRole ?? draft?.targetRole ?? context.activeAssetContext?.activeJD?.targetRole,
      source: sourceFor({ explicit: stringValue(explicitArgs.jdId) ?? explicitText, client: context.clientState?.activeJDId, workspace: workspace?.active?.jdId ?? workspace?.jdId, handoff: handoff?.extracted.jdId ?? handoff?.extracted.jdText, draft: draft?.rawText, active: context.activeAssetContext?.activeJD?.id }),
    };
  }

  public resolveExperience(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const draft = mostRecentExperienceDraft(workspace);
    const id =
      stringValue(explicitArgs.experienceId)
      ?? stringValue(explicitArgs.id)
      ?? context.clientState?.activeExperienceId
      ?? workspace?.active?.experienceId
      ?? handoff?.extracted.experienceId
      ?? context.activeAssetContext?.activeExperience?.id;
    const text =
      stringValue(explicitArgs.content)
      ?? stringValue(explicitArgs.instruction)
      ?? stringValue(context.clientState?.selectedText)
      ?? handoff?.extracted.experienceText
      ?? draft?.rawText
      ?? activeExperienceText(context.activeAssetContext);
    return {
      id,
      draftId: workspace?.active?.experienceDraftId ?? draft?.id,
      text,
      source: sourceFor({ explicit: stringValue(explicitArgs.experienceId) ?? stringValue(explicitArgs.id), client: context.clientState?.activeExperienceId, workspace: workspace?.active?.experienceId, handoff: handoff?.extracted.experienceId ?? handoff?.extracted.experienceText, draft: draft?.rawText, active: context.activeAssetContext?.activeExperience?.id }),
    };
  }

  public resolveResume(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const draft = mostRecentResumeDraft(workspace);
    const id =
      stringValue(explicitArgs.resumeId)
      ?? stringValue(explicitArgs.id)
      ?? context.clientState?.activeResumeId
      ?? workspace?.active?.resumeId
      ?? workspace?.resumeId
      ?? workspace?.activeResume?.id
      ?? handoff?.extracted.resumeId
      ?? context.activeAssetContext?.activeResume?.id;
    return {
      id,
      draftId: draft?.id,
      text: handoff?.extracted.resumeText ?? draft?.rawText,
      source: sourceFor({ explicit: stringValue(explicitArgs.resumeId) ?? stringValue(explicitArgs.id), client: context.clientState?.activeResumeId, workspace: workspace?.active?.resumeId ?? workspace?.resumeId, handoff: handoff?.extracted.resumeId, draft: draft?.rawText, active: context.activeAssetContext?.activeResume?.id }),
    };
  }

  public resolveResumeItem(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const id =
      stringValue(explicitArgs.resumeItemId)
      ?? context.clientState?.activeResumeItemId
      ?? workspace?.active?.resumeItemId
      ?? handoff?.extracted.resumeItemId
      ?? context.activeAssetContext?.activeResume?.selectedItem?.id;
    return {
      id,
      text: stringValue(explicitArgs.instruction) ?? stringValue(context.clientState?.selectedText) ?? activeResumeItemText(context.activeAssetContext),
      source: sourceFor({ explicit: stringValue(explicitArgs.resumeItemId), client: context.clientState?.activeResumeItemId, workspace: workspace?.active?.resumeItemId, handoff: handoff?.extracted.resumeItemId, active: context.activeAssetContext?.activeResume?.selectedItem?.id }),
    };
  }

  public resolveVariant(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const id =
      stringValue(explicitArgs.variantId)
      ?? stringValue(explicitArgs.id)
      ?? stringValue(explicitArgs.evidenceId)
      ?? context.clientState?.activeVariantId
      ?? stringValue(context.clientState?.selectedEvidenceChainId)
      ?? workspace?.active?.variantId
      ?? workspace?.selectedEvidenceChainId
      ?? workspace?.activeVariantId
      ?? handoff?.extracted.variantId
      ?? context.activeAssetContext?.activeVariant?.id;
    return { id, source: sourceFor({ explicit: stringValue(explicitArgs.variantId) ?? stringValue(explicitArgs.id), client: context.clientState?.activeVariantId, workspace: workspace?.active?.variantId ?? workspace?.activeVariantId, handoff: handoff?.extracted.variantId, active: context.activeAssetContext?.activeVariant?.id }) };
  }

  public resolveSelectedText(context: ResolverRunContext, _workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    return {
      text: stringValue(explicitArgs.selectedText) ?? stringValue(explicitArgs.instruction) ?? stringValue(context.clientState?.selectedText),
    };
  }
}

function currentHandoff(context: ResolverRunContext): FrontDeskHandoff | undefined {
  const value = context.productContext.frontDeskHandoff;
  return typeof value === "object" && value !== null ? value as FrontDeskHandoff : undefined;
}

function sourceFor(values: Record<string, unknown>): string | undefined {
  return Object.entries(values).find(([, value]) => typeof value === "string" && value.trim())?.[0];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
