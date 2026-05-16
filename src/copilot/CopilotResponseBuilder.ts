import { randomUUID } from "node:crypto";
import type { ArtifactCritiqueItem } from "../application/critique/types.js";
import type { ArtifactDecisionRecord } from "../application/decisions/index.js";
import type { Evidence, EvidenceChain, GeneratedArtifact } from "../knowledge/types.js";
import type {
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductAction,
  ProductTimelineItem,
  ProductVariant,
} from "./types.js";

export type BuildChatResponseInput = {
  sessionId: string;
  turnId: string;
  userMessage: string;
  generatedArtifacts?: GeneratedArtifact[];
  critiqueItems?: ArtifactCritiqueItem[];
  evidenceChains?: EvidenceChain[];
  decisions?: ArtifactDecisionRecord[];
  targetRole?: string | null;
  clientState?: Record<string, unknown>;
};

export type BuildVariantInput = {
  artifact: GeneratedArtifact;
  critiqueItems?: ArtifactCritiqueItem[];
  evidenceChains?: EvidenceChain[];
  targetRole?: string | null;
};

export class CopilotResponseBuilder {
  public buildChatResponse(input: BuildChatResponseInput): CopilotChatResponse {
    const artifacts = input.generatedArtifacts ?? [];
    const critiques = input.critiqueItems ?? [];
    const evidenceChains = input.evidenceChains ?? [];

    const variants = artifacts.map((artifact) =>
      this.buildVariant({
        artifact,
        critiqueItems: critiques,
        evidenceChains,
        targetRole: input.targetRole,
      }),
    );

    const workspaceSummary = this.buildWorkspaceSummary(variants, critiques);
    const workspaceStatus = this.resolveWorkspaceStatus(variants);

    const workspace: CopilotWorkspace = {
      id: `ws-${input.sessionId}`,
      sessionId: input.sessionId,
      activeVariantId: variants.length > 0 ? variants[0].id : null,
      variants,
      status: workspaceStatus,
      summary: workspaceSummary,
      updatedAt: new Date().toISOString(),
    };

    const assistantMessage = this.buildAssistantMessage(input, variants, critiques);
    const timeline = this.buildTimeline(input, artifacts);
    const nextActions = this.buildNextActions({ variants, workspaceStatus });

    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      assistantMessage,
      timeline,
      workspace,
      nextActions,
      raw: {
        artifactIds: artifacts.map((a) => a.id),
        evidenceChainIds: evidenceChains.map((ec) => ec.id),
        critiqueItemIds: critiques.map((c) => c.artifactId).filter(Boolean),
        decisionIds: (input.decisions ?? []).map((d) => d.id),
      },
    };
  }

  public buildVariant(input: BuildVariantInput): ProductVariant {
    const artifact = input.artifact;
    const critique = (input.critiqueItems ?? []).find((c) => c.artifactId === artifact.id);
    const evidence = (input.evidenceChains ?? []).find((ec) =>
      (artifact.sourceEvidenceIds ?? []).some((id) => ecContainsEvidence(ec, id)),
    );

    const enhancementStatus = readEnhancementStatus(artifact);

    const badges: ProductVariant["badges"] = [];
    if (enhancementStatus === "ready") {
      badges.push({ label: "Ready to use", tone: "positive" });
    } else if (enhancementStatus === "needs_confirmation") {
      badges.push({ label: "Needs confirmation", tone: "warning" });
    } else if (enhancementStatus === "unsafe") {
      badges.push({ label: "Unsafe", tone: "danger" });
    }
    if (critique) {
      if (critique.verdict === "pass") badges.push({ label: "Critique: pass", tone: "positive" });
      if (critique.verdict === "revise") badges.push({ label: "Critique: revise", tone: "warning" });
      if (critique.verdict === "reject") badges.push({ label: "Critique: reject", tone: "danger" });
    }

    const highlights: ProductVariant["highlights"] = [];
    if (critique?.claimReviews) {
      for (const claim of critique.claimReviews.slice(0, 3)) {
        highlights.push({
          label: claim.supportLevel ?? "unknown",
          text: claim.claimText ?? "",
        });
      }
    }

    const critiqueSummary = critique
      ? {
          strengths: critique.rewriteSuggestions?.slice(0, 2) ?? [],
          risks: [
            ...(critique.unsupportedClaims ?? []),
            ...(critique.missingEvidence ?? []),
          ],
          suggestions: critique.rewriteSuggestions ?? [],
        }
      : undefined;

    const evidenceItems = (evidence?.sourceEvidences ?? []).map((ev) => ({
      id: ev.id,
      title: ev.excerpt ? truncate(ev.excerpt, 80) : "Evidence",
      quote: ev.excerpt ?? undefined,
      explanation: ev.sourceRef ?? "",
      confidence: ev.confidence,
    }));

    const evidenceSummary = evidence
      ? {
          coverageLabel:
            evidenceItems.length > 0
              ? `${evidenceItems.length} source items`
              : "No direct evidence",
          items: evidenceItems,
        }
      : undefined;

    return {
      id: artifact.id,
      artifactId: artifact.id,
      title: artifact.content
        ? truncate(artifact.content.replace(/\s+/g, " ").trim(), 80)
        : "Untitled variant",
      subtitle: artifact.type ?? null,
      after: artifact.content ?? "",
      targetRole: input.targetRole ?? artifact.targetRole ?? null,
      score: {
        overall: artifact.scores?.overall,
        relevance: artifact.scores?.requirementMatch,
        evidenceStrength: artifact.scores?.evidenceStrength,
      },
      badges,
      highlights,
      critiqueSummary,
      evidenceSummary,
      decisionState: "undecided",
      createdAt: artifact.createdAt ?? new Date().toISOString(),
    };
  }

  public buildNextActions(input: {
    variants: ProductVariant[];
    workspaceStatus: CopilotWorkspace["status"];
  }): ProductAction[] {
    const actions: ProductAction[] = [];

    if (input.variants.length === 0) return actions;

    for (const variant of input.variants) {
      actions.push({
        id: `accept-${variant.id}`,
        type: "accept",
        label: "Accept",
        variantId: variant.id,
      });
      actions.push({
        id: `reject-${variant.id}`,
        type: "reject",
        label: "Reject",
        variantId: variant.id,
      });
      actions.push({
        id: `prefer-${variant.id}`,
        type: "prefer",
        label: "Prefer this version",
        variantId: variant.id,
      });
      actions.push({
        id: `conservative-${variant.id}`,
        type: "revise_more_conservative",
        label: "More conservative",
        variantId: variant.id,
      });
      actions.push({
        id: `quantified-${variant.id}`,
        type: "revise_more_quantified",
        label: "More quantified",
        variantId: variant.id,
      });
      actions.push({
        id: `evidence-${variant.id}`,
        type: "show_evidence",
        label: "Show evidence",
        variantId: variant.id,
      });
      actions.push({
        id: `explain-${variant.id}`,
        type: "explain_choice",
        label: "Explain this choice",
        variantId: variant.id,
      });

      // Only need actions for the first few variants
      if (actions.length >= 14) break;
    }

    if (input.workspaceStatus === "awaiting_user_decision") {
      actions.unshift({
        id: `confirm-metric-${randomUUID()}`,
        type: "confirm_metric",
        label: "Confirm a metric",
        description: "Confirm a specific metric or number in the content",
        requiresInput: true,
        inputPlaceholder: "Which metric and what value?",
      });
    }

    return actions;
  }

  public buildTimeline(
    input: BuildChatResponseInput,
    artifacts: GeneratedArtifact[],
  ): ProductTimelineItem[] {
    const now = new Date().toISOString();
    const items: ProductTimelineItem[] = [
      {
        id: `tl-${input.turnId}-1`,
        type: "user_submitted",
        title: "Message received",
        description: input.userMessage.length > 100
          ? `${input.userMessage.slice(0, 97)}...`
          : input.userMessage,
        status: "completed",
        createdAt: now,
      },
    ];

    if (artifacts.length > 0) {
      items.push({
        id: `tl-${input.turnId}-2`,
        type: "variant_generated",
        title: `${artifacts.length} variants generated`,
        description: `Generated ${artifacts.length} candidate rewrites based on experience and job description.`,
        status: "completed",
        createdAt: now,
        relatedVariantId: artifacts[0].id,
      });
    }

    if ((input.critiqueItems ?? []).length > 0) {
      items.push({
        id: `tl-${input.turnId}-3`,
        type: "critique_completed",
        title: "Critique completed",
        description: "Each variant has been reviewed for accuracy, evidence support, and risk.",
        status: "completed",
        createdAt: now,
      });
    }

    if (input.evidenceChains && input.evidenceChains.length > 0) {
      items.push({
        id: `tl-${input.turnId}-4`,
        type: "evidence_attached",
        title: "Evidence attached",
        description: `${input.evidenceChains.length} evidence chains linked to variants.`,
        status: "completed",
        createdAt: now,
      });
    }

    return items;
  }

  private buildAssistantMessage(
    input: BuildChatResponseInput,
    variants: ProductVariant[],
    critiques: ArtifactCritiqueItem[],
  ): CopilotMessage {
    const content = this.composeAssistantContent(input, variants, critiques);
    return {
      id: `msg-${input.turnId}-assistant`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: "assistant",
      content,
      kind: variants.length > 0 ? "variant_suggestion" : "plain_text",
      createdAt: new Date().toISOString(),
    };
  }

  private composeAssistantContent(
    input: BuildChatResponseInput,
    variants: ProductVariant[],
    critiques: ArtifactCritiqueItem[],
  ): string {
    if (variants.length === 0) {
      return "I've analyzed your input but wasn't able to generate variants yet. Could you provide more context, like a job description or target role?";
    }

    const passCount = critiques.filter((c) => c.verdict === "pass").length;
    const reviseCount = critiques.filter((c) => c.verdict === "revise").length;
    const rejectCount = critiques.filter((c) => c.verdict === "reject").length;

    const parts: string[] = [
      `I've generated ${variants.length} candidate rewrites for ${input.targetRole ?? "your target role"}.`,
    ];

    if (critiques.length > 0) {
      parts.push(`${passCount} passed critique, ${reviseCount} need revision, ${rejectCount} were rejected.`);
    }

    parts.push("Review each variant and accept, reject, or request a revision.");

    return parts.join(" ");
  }

  public buildClarifyingQuestion(sessionId: string, turnId: string, question: string): CopilotChatResponse {
    const now = new Date().toISOString();
    return {
      sessionId,
      turnId,
      assistantMessage: {
        id: `msg-${turnId}-assistant`,
        sessionId,
        turnId,
        role: "assistant",
        content: question,
        kind: "clarifying_question",
        createdAt: now,
      },
      timeline: [
        {
          id: `tl-${turnId}-1`,
          type: "user_submitted",
          title: "Message received",
          status: "completed",
          createdAt: now,
        },
      ],
      workspace: {
        id: `ws-${sessionId}`,
        sessionId,
        variants: [],
        status: "empty",
        updatedAt: now,
      },
      nextActions: [],
      raw: {
        artifactIds: [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
      },
    };
  }

  public buildExplainChoice(input: {
    sessionId: string;
    turnId: string;
    variantTitle: string;
    variantId: string;
    reason: string;
  }): CopilotChatResponse {
    const now = new Date().toISOString();
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      assistantMessage: {
        id: `msg-${input.turnId}-assistant`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: "assistant",
        content: `"${input.variantTitle}" was recommended because: ${input.reason}`,
        kind: "decision_summary",
        createdAt: now,
      },
      timeline: [],
      workspace: {
        id: `ws-${input.sessionId}`,
        sessionId: input.sessionId,
        variants: [],
        status: "ready",
        updatedAt: now,
      },
      nextActions: [],
      raw: {
        artifactIds: [input.variantId],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
      },
    };
  }

  public buildShowEvidence(input: {
    sessionId: string;
    turnId: string;
    variantId: string;
    evidenceItems: NonNullable<ProductVariant["evidenceSummary"]>["items"];
  }): CopilotChatResponse {
    const now = new Date().toISOString();
    const lines = input.evidenceItems.map(
      (item) => `- ${item.title}: ${item.explanation}${item.quote ? ` ("${truncate(item.quote, 60)}")` : ""}`,
    );
    const content =
      lines.length > 0
        ? `Evidence for this variant:\n\n${lines.join("\n")}`
        : "No direct evidence found for this variant.";

    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      assistantMessage: {
        id: `msg-${input.turnId}-assistant`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: "assistant",
        content,
        kind: "evidence_explanation",
        createdAt: now,
      },
      timeline: [],
      workspace: {
        id: `ws-${input.sessionId}`,
        sessionId: input.sessionId,
        variants: [],
        status: "ready",
        updatedAt: now,
      },
      nextActions: [],
      raw: {
        artifactIds: [input.variantId],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
      },
    };
  }

  private buildWorkspaceSummary(
    variants: ProductVariant[],
    critiques: ArtifactCritiqueItem[],
  ): string | undefined {
    if (variants.length === 0) return undefined;
    const passCount = critiques.filter((c) => c.verdict === "pass").length;
    return `${variants.length} variants, ${passCount} strong candidates`;
  }

  private resolveWorkspaceStatus(variants: ProductVariant[]): CopilotWorkspace["status"] {
    if (variants.length === 0) return "empty";
    const hasNeedsConfirmation = variants.some((v) =>
      v.badges.some((b) => b.label === "Needs confirmation"),
    );
    if (hasNeedsConfirmation) return "awaiting_user_decision";
    return "ready";
  }
}

function ecContainsEvidence(ec: EvidenceChain, evidenceId: string): boolean {
  return (ec.sourceEvidences ?? []).some((ev: Evidence) => ev.id === evidenceId);
}

function readEnhancementStatus(artifact: GeneratedArtifact): string | undefined {
  const enhancement = artifact.metadata?.enhancement;
  if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
    return undefined;
  }
  const status = (enhancement as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
