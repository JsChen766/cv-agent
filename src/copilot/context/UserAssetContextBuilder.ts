import type { ApiKernel } from "../../api/types.js";
import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { CopilotClientState, CopilotWorkspace } from "../types.js";
import type { ActiveAssetContext } from "../ActiveAssetContextBuilder.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";
import type { DraftManifestItem, UserAssetContext } from "./UserAssetContext.js";
import { normalizeDraftContext } from "./DraftContext.js";
import { isCanonicalExperienceId, isCanonicalJDId, isCanonicalResumeId, isCanonicalVariantId } from "./IdGuards.js";

const MAX_EXPERIENCES = 20;
const MAX_JDS = 20;
const MAX_RESUMES = 10;
const MAX_GENERATIONS = 10;
const MAX_SUMMARY_CHARS = 160;

export class UserAssetContextBuilder {
  public constructor(private readonly kernel: Pick<ApiKernel, "productServices">) {}

  public async build(input: {
    userId: string;
    workspace: CopilotWorkspace | null;
    clientState?: CopilotClientState;
    activeAssetContext?: ActiveAssetContext;
    productContext: Record<string, unknown>;
    userMessage: string;
  }): Promise<UserAssetContext> {
    const services = this.kernel.productServices;

    const [experiences, jds, resumes, generations] = await Promise.all([
      services.experienceService.listExperiences(input.userId, { limit: MAX_EXPERIENCES }).catch(() => []),
      services.jdService.listJDs(input.userId, MAX_JDS).catch(() => []),
      services.resumeService.listResumes(input.userId, MAX_RESUMES).catch(() => []),
      services.generationProductService.listGenerations(input.userId, MAX_GENERATIONS).catch(() => []),
    ]);

    const drafts = buildDraftManifest(input.workspace);
    const active = buildActive(input);

    const context: UserAssetContext = {
      experiences: experiences.map((item) => ({
        id: item.id,
        type: "experience" as const,
        title: item.title,
        organization: item.organization,
        role: item.role,
        tags: item.tags,
        summary: truncate(item.content, MAX_SUMMARY_CHARS),
        updatedAt: item.updatedAt,
        source: item.id === active.experienceId ? "active" : "saved",
      })),
      jds: jds.map((item) => ({
        id: item.id,
        type: "jd" as const,
        title: item.title,
        company: item.company,
        targetRole: item.targetRole,
        summary: truncate(item.rawText, MAX_SUMMARY_CHARS),
        updatedAt: item.updatedAt,
        source: item.id === active.jdId ? "active" : "saved",
      })),
      resumes: resumes.map((item) => ({
        id: item.id,
        type: "resume" as const,
        title: item.title,
        targetRole: item.targetRole,
        updatedAt: item.updatedAt,
        source: item.id === active.resumeId ? "active" : "saved",
      })),
      generations: generations.map((item) => ({
        id: item.id,
        type: "generation" as const,
        title: item.targetRole ?? "Generation",
        targetRole: item.targetRole,
        summary: `${item.outputSnapshot?.variants?.length ?? 0} variants`,
        updatedAt: item.createdAt,
      })),
      drafts,
      active,
      counts: {
        experiences: experiences.length,
        jds: jds.length,
        resumes: resumes.length,
        generations: generations.length,
        drafts: drafts.length,
      },
      retrievalPolicy: {
        mode: "manifest_only",
        maxItemsPerType: MAX_EXPERIENCES,
        maxSummaryChars: MAX_SUMMARY_CHARS,
      },
    };

    return context;
  }
}

function buildActive(input: {
  workspace: CopilotWorkspace | null;
  clientState?: CopilotClientState;
  activeAssetContext?: ActiveAssetContext;
}): UserAssetContext["active"] {
  const ws = input.workspace;
  const cs = input.clientState ?? {};
  const ac = input.activeAssetContext;

  const active: UserAssetContext["active"] = {};

  // Experience
  const rawExpId = cs.activeExperienceId ?? ws?.active?.experienceId ?? ac?.activeExperience?.id;
  active.experienceId = isCanonicalExperienceId(rawExpId) ? rawExpId : undefined;
  if (!active.experienceId) {
    active.experienceDraftId = ws?.active?.experienceDraftId;
  }

  // JD
  const rawJdId = cs.activeJDId ?? ws?.active?.jdId ?? ws?.jdId ?? ac?.activeJD?.id;
  active.jdId = isCanonicalJDId(rawJdId) ? rawJdId : undefined;
  if (!active.jdId) {
    active.jdDraftId = ws?.active?.jdDraftId;
  }

  // Resume
  const rawResumeId = cs.activeResumeId ?? ws?.active?.resumeId ?? ws?.resumeId ?? ac?.activeResume?.id;
  active.resumeId = isCanonicalResumeId(rawResumeId) ? rawResumeId : undefined;

  // Variant
  const rawVariantId =
    cs.activeVariantId ?? ws?.active?.variantId ?? ws?.activeVariantId ?? ac?.activeVariant?.id;
  active.variantId = isCanonicalVariantId(rawVariantId) ? rawVariantId : undefined;

  return active;
}

function buildDraftManifest(workspace: CopilotWorkspace | null): DraftManifestItem[] {
  const drafts = normalizeDraftContext(workspace?.drafts);
  const items: DraftManifestItem[] = [];

  for (const draft of drafts.jdDrafts) {
    items.push({
      id: draft.id,
      type: "jdDraft",
      title: draft.title,
      summary: truncate(draft.rawText, MAX_SUMMARY_CHARS),
      rawTextPreview: truncate(draft.rawText, MAX_SUMMARY_CHARS),
      targetRole: draft.targetRole,
      company: draft.company,
      updatedAt: draft.updatedAt,
    });
  }

  for (const draft of drafts.experienceDrafts) {
    items.push({
      id: draft.id,
      type: "experienceDraft",
      title: draft.title,
      summary: truncate(draft.rawText, MAX_SUMMARY_CHARS),
      rawTextPreview: truncate(draft.rawText, MAX_SUMMARY_CHARS),
      updatedAt: draft.updatedAt,
    });
  }

  for (const draft of drafts.resumeDrafts) {
    items.push({
      id: draft.id,
      type: "resumeDraft",
      summary: truncate(draft.rawText, MAX_SUMMARY_CHARS),
      rawTextPreview: truncate(draft.rawText, MAX_SUMMARY_CHARS),
      updatedAt: draft.updatedAt,
    });
  }

  return items;
}

function truncate(value: unknown, max: number): string | undefined {
  if (!value) return undefined;
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
