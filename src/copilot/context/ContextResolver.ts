import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";
import { activeExperienceText, activeJDText, activeResumeItemText } from "./ActiveAssetResolver.js";
import { AssetMentionResolver } from "./AssetMentionResolver.js";
import { mostRecentExperienceDraft, mostRecentJDDraft, mostRecentResumeDraft } from "./DraftContext.js";
import { isCanonicalExperienceId, isCanonicalJDId, isCanonicalResumeId, isCanonicalVariantId } from "./IdGuards.js";
import type { UserAssetContext } from "./UserAssetContext.js";

export type ResolverRunContext = Pick<AgentContext, "clientState" | "activeAssetContext" | "productContext" | "userMessage" | "userAssetContext"> & {
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
  private readonly mentionResolver = new AssetMentionResolver();

  public resolveJD(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const draft = mostRecentJDDraft(workspace);
    const explicitText = stringValue(explicitArgs.jdText) ?? stringValue(explicitArgs.text);
    const explicitRawId = stringValue(explicitArgs.jdId) ?? stringValue(explicitArgs.id);
    const explicitId = isCanonicalJDId(explicitRawId) ? explicitRawId : undefined;
    const queryFromExplicit = !explicitId && explicitRawId ? explicitRawId : undefined;
    const query = stringValue(explicitArgs.query) ?? queryFromExplicit;
    const id =
      explicitId
      ?? context.clientState?.activeJDId
      ?? workspace?.active?.jdId
      ?? workspace?.jdId
      ?? context.userAssetContext?.active.jdId
      ?? handoff?.extracted.jdId
      ?? context.activeAssetContext?.activeJD?.id
      ?? (query && context.userAssetContext ? this.mentionResolver.matchJD(query, context.userAssetContext).match?.id : undefined);
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
      source: sourceFor({ explicit: explicitId, client: context.clientState?.activeJDId, workspace: workspace?.active?.jdId ?? workspace?.jdId, userAsset: context.userAssetContext?.active.jdId, handoff: handoff?.extracted.jdId, manifestMatch: context.userAssetContext ? "manifest" : undefined, active: context.activeAssetContext?.activeJD?.id }),
    };
  }

  public resolveExperience(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const draft = mostRecentExperienceDraft(workspace);
    const explicitRawId = stringValue(explicitArgs.experienceId) ?? stringValue(explicitArgs.id);
    const explicitId = isCanonicalExperienceId(explicitRawId) ? explicitRawId : undefined;
    const queryFromExplicit = !explicitId && explicitRawId ? explicitRawId : undefined;
    const query = stringValue(explicitArgs.query) ?? queryFromExplicit;
    const id =
      explicitId
      ?? context.clientState?.activeExperienceId
      ?? workspace?.active?.experienceId
      ?? context.userAssetContext?.active.experienceId
      ?? handoff?.extracted.experienceId
      ?? context.activeAssetContext?.activeExperience?.id
      ?? (query && context.userAssetContext ? this.mentionResolver.matchExperience(query, context.userAssetContext).match?.id : undefined);
    const text =
      stringValue(explicitArgs.content)
      ?? stringValue(context.clientState?.selectedText)
      ?? handoff?.extracted.experienceText
      ?? draft?.rawText
      ?? activeExperienceText(context.activeAssetContext);
    return {
      id,
      draftId: workspace?.active?.experienceDraftId ?? draft?.id,
      text,
      source: sourceFor({ explicit: explicitId, client: context.clientState?.activeExperienceId, workspace: workspace?.active?.experienceId, userAsset: context.userAssetContext?.active.experienceId, handoff: handoff?.extracted.experienceId, manifestMatch: context.userAssetContext ? "manifest" : undefined, active: context.activeAssetContext?.activeExperience?.id }),
    };
  }

  public resolveResume(context: ResolverRunContext, workspace: CopilotWorkspace | null, explicitArgs: Record<string, unknown> = {}): ResolvedAsset {
    const handoff = currentHandoff(context);
    const draft = mostRecentResumeDraft(workspace);
    const explicitRawId = stringValue(explicitArgs.resumeId) ?? stringValue(explicitArgs.id);
    const explicitId = isCanonicalResumeId(explicitRawId) ? explicitRawId : undefined;
    const queryFromExplicit = !explicitId && explicitRawId ? explicitRawId : undefined;
    const query = stringValue(explicitArgs.query) ?? queryFromExplicit;
    const id =
      explicitId
      ?? context.clientState?.activeResumeId
      ?? workspace?.active?.resumeId
      ?? workspace?.resumeId
      ?? workspace?.activeResume?.id
      ?? context.userAssetContext?.active.resumeId
      ?? handoff?.extracted.resumeId
      ?? context.activeAssetContext?.activeResume?.id
      ?? (query && context.userAssetContext ? this.mentionResolver.matchResume(query, context.userAssetContext).match?.id : undefined);
    return {
      id,
      draftId: draft?.id,
      text: handoff?.extracted.resumeText ?? draft?.rawText,
      source: sourceFor({ explicit: explicitId, client: context.clientState?.activeResumeId, workspace: workspace?.active?.resumeId ?? workspace?.resumeId, userAsset: context.userAssetContext?.active.resumeId, handoff: handoff?.extracted.resumeId, draft: draft?.rawText, active: context.activeAssetContext?.activeResume?.id }),
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
    const explicitRawId = stringValue(explicitArgs.variantId) ?? stringValue(explicitArgs.id);
    const explicitId = isCanonicalVariantId(explicitRawId) ? explicitRawId : undefined;
    const explicitEvidenceRawId = stringValue(explicitArgs.evidenceId);
    const explicitEvidenceId = isCanonicalExperienceId(explicitEvidenceRawId) ? explicitEvidenceRawId : undefined;
    const selectedChainId = stringValue(context.clientState?.selectedEvidenceChainId);
    const guardedChainId = selectedChainId && isCanonicalVariantId(selectedChainId) ? selectedChainId : undefined;
    const workspaceChainId = workspace?.selectedEvidenceChainId;
    const guardedWorkspaceChainId = typeof workspaceChainId === "string" && isCanonicalVariantId(workspaceChainId) ? workspaceChainId : undefined;
    const id =
      explicitId
      ?? explicitEvidenceId
      ?? context.clientState?.activeVariantId
      ?? guardedChainId
      ?? workspace?.active?.variantId
      ?? guardedWorkspaceChainId
      ?? workspace?.activeVariantId
      ?? handoff?.extracted.variantId
      ?? context.activeAssetContext?.activeVariant?.id;
    return { id, source: sourceFor({ explicit: explicitId, client: context.clientState?.activeVariantId, workspace: workspace?.active?.variantId ?? workspace?.activeVariantId, handoff: handoff?.extracted.variantId, active: context.activeAssetContext?.activeVariant?.id }) };
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
