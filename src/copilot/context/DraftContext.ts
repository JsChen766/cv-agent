import { randomUUID } from "node:crypto";
import type { CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";

export type DraftSource = "current_message" | "uploaded_file" | "composer" | "handoff";
export type DraftStatus = "draft" | "confirmed" | "saved" | "discarded";

export type JDDraft = {
  id: string;
  kind: "jd";
  rawText: string;
  title?: string;
  company?: string;
  targetRole?: string;
  extractedRequirements?: unknown;
  source: DraftSource;
  status: DraftStatus;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt: string;
};

export type ExperienceDraft = {
  id: string;
  kind: "experience";
  rawText: string;
  title?: string;
  category?: string;
  organization?: string;
  role?: string;
  source: DraftSource;
  status: DraftStatus;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt: string;
};

export type ResumeDraft = {
  id: string;
  kind: "resume";
  rawText: string;
  source: DraftSource;
  status: DraftStatus;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt: string;
};

export type DraftContext = {
  jdDrafts: JDDraft[];
  experienceDrafts: ExperienceDraft[];
  resumeDrafts: ResumeDraft[];
};

export function emptyDraftContext(): DraftContext {
  return { jdDrafts: [], experienceDrafts: [], resumeDrafts: [] };
}

export function normalizeDraftContext(value: unknown): DraftContext {
  const record = isRecord(value) ? value : {};
  return {
    jdDrafts: Array.isArray(record.jdDrafts) ? record.jdDrafts.filter(isJDDraft).slice(0, 5) : [],
    experienceDrafts: Array.isArray(record.experienceDrafts) ? record.experienceDrafts.filter(isExperienceDraft).slice(0, 5) : [],
    resumeDrafts: Array.isArray(record.resumeDrafts) ? record.resumeDrafts.filter(isResumeDraft).slice(0, 5) : [],
  };
}

export function applyHandoffToDrafts(
  workspace: CopilotWorkspace | null,
  handoff: FrontDeskHandoff,
  now: string,
): Pick<CopilotWorkspace, "drafts" | "active"> {
  const drafts = normalizeDraftContext(workspace?.drafts);
  const active = { ...(workspace?.active ?? {}) };

  if (handoff.extracted.jdText?.trim()) {
    const draft = upsertJDDraft(drafts.jdDrafts, handoff, now);
    drafts.jdDrafts = keepRecentDrafts([draft, ...drafts.jdDrafts.filter((item) => item.id !== draft.id)]);
    active.jdDraftId = draft.id;
  }

  if (handoff.extracted.experienceText?.trim()) {
    const draft = upsertExperienceDraft(drafts.experienceDrafts, handoff, now);
    drafts.experienceDrafts = keepRecentDrafts([draft, ...drafts.experienceDrafts.filter((item) => item.id !== draft.id)]);
    active.experienceDraftId = draft.id;
  }

  if (handoff.extracted.resumeText?.trim()) {
    const draft = upsertResumeDraft(drafts.resumeDrafts, handoff, now);
    drafts.resumeDrafts = keepRecentDrafts([draft, ...drafts.resumeDrafts.filter((item) => item.id !== draft.id)]);
    active.resumeId = active.resumeId ?? handoff.extracted.resumeId;
  }

  if (handoff.extracted.jdId) active.jdId = handoff.extracted.jdId;
  if (handoff.extracted.experienceId) active.experienceId = handoff.extracted.experienceId;
  if (handoff.extracted.resumeId) active.resumeId = handoff.extracted.resumeId;
  if (handoff.extracted.resumeItemId) active.resumeItemId = handoff.extracted.resumeItemId;
  if (handoff.extracted.variantId) active.variantId = handoff.extracted.variantId;

  return { drafts, active };
}

export function mostRecentJDDraft(workspace: CopilotWorkspace | null): JDDraft | undefined {
  return pickRecent(normalizeDraftContext(workspace?.drafts).jdDrafts);
}

export function mostRecentExperienceDraft(workspace: CopilotWorkspace | null): ExperienceDraft | undefined {
  return pickRecent(normalizeDraftContext(workspace?.drafts).experienceDrafts);
}

export function mostRecentResumeDraft(workspace: CopilotWorkspace | null): ResumeDraft | undefined {
  return pickRecent(normalizeDraftContext(workspace?.drafts).resumeDrafts);
}

function upsertJDDraft(existing: JDDraft[], handoff: FrontDeskHandoff, now: string): JDDraft {
  const id = handoff.extracted.jdId ?? existing[0]?.id ?? `jddraft-${randomUUID()}`;
  const current = existing.find((item) => item.id === id);
  return {
    id,
    kind: "jd",
    rawText: handoff.extracted.jdText ?? current?.rawText ?? "",
    title: handoff.extracted.title ?? current?.title,
    company: handoff.extracted.company ?? current?.company,
    targetRole: handoff.extracted.targetRole ?? current?.targetRole,
    extractedRequirements: handoff.extracted.requirements ?? current?.extractedRequirements,
    source: "handoff",
    status: current?.status ?? "draft",
    confidence: handoff.confidence,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    lastReferencedAt: now,
  };
}

function upsertExperienceDraft(existing: ExperienceDraft[], handoff: FrontDeskHandoff, now: string): ExperienceDraft {
  const id = handoff.extracted.experienceId ?? existing[0]?.id ?? `expdraft-${randomUUID()}`;
  const current = existing.find((item) => item.id === id);
  return {
    id,
    kind: "experience",
    rawText: handoff.extracted.experienceText ?? current?.rawText ?? "",
    title: handoff.extracted.title ?? current?.title,
    source: "handoff",
    status: current?.status ?? "draft",
    confidence: handoff.confidence,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    lastReferencedAt: now,
  };
}

function upsertResumeDraft(existing: ResumeDraft[], handoff: FrontDeskHandoff, now: string): ResumeDraft {
  const id = existing[0]?.id ?? `resdraft-${randomUUID()}`;
  const current = existing.find((item) => item.id === id);
  return {
    id,
    kind: "resume",
    rawText: handoff.extracted.resumeText ?? current?.rawText ?? "",
    source: "handoff",
    status: current?.status ?? "draft",
    confidence: handoff.confidence,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    lastReferencedAt: now,
  };
}

function keepRecentDrafts<T extends { status: DraftStatus; lastReferencedAt: string }>(drafts: T[]): T[] {
  return drafts
    .filter((draft) => draft.status === "draft" || draft.status === "confirmed")
    .sort((a, b) => Date.parse(b.lastReferencedAt) - Date.parse(a.lastReferencedAt))
    .slice(0, 5);
}

function pickRecent<T extends { lastReferencedAt: string }>(drafts: T[]): T | undefined {
  return [...drafts].sort((a, b) => Date.parse(b.lastReferencedAt) - Date.parse(a.lastReferencedAt))[0];
}

function isJDDraft(value: unknown): value is JDDraft {
  return isRecord(value) && value.kind === "jd" && typeof value.id === "string" && typeof value.rawText === "string";
}

function isExperienceDraft(value: unknown): value is ExperienceDraft {
  return isRecord(value) && value.kind === "experience" && typeof value.id === "string" && typeof value.rawText === "string";
}

function isResumeDraft(value: unknown): value is ResumeDraft {
  return isRecord(value) && value.kind === "resume" && typeof value.id === "string" && typeof value.rawText === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
