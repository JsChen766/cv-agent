import { randomUUID } from "node:crypto";
import type { ArtifactCritiqueItem } from "../application/critique/types.js";
import type { ArtifactDecisionRecord } from "../application/decisions/index.js";
import type { Evidence, EvidenceChain, GeneratedArtifact } from "../knowledge/types.js";
import type {
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductAction,
  ProductActionType,
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
  allVariants?: GeneratedArtifact[];
  bestScore?: number;
};

export class CopilotResponseBuilder {
  public buildChatResponse(input: BuildChatResponseInput): CopilotChatResponse {
    const artifacts = input.generatedArtifacts ?? [];
    const critiques = input.critiqueItems ?? [];
    const evidenceChains = input.evidenceChains ?? [];

    // Find best score for role assignment
    const bestScore = artifacts.reduce((max, a) => Math.max(max, a.scores?.overall ?? 0), 0);

    const variants = artifacts.map((artifact) =>
      this.buildVariant({
        artifact,
        critiqueItems: critiques,
        evidenceChains,
        targetRole: input.targetRole,
        allVariants: artifacts,
        bestScore,
      }),
    );

    // Mark recommended variant
    this.markRecommended(variants, bestScore);

    const workspaceStatus = this.resolveWorkspaceStatus(variants);

    const workspace: CopilotWorkspace = {
      id: `ws-${input.sessionId}`,
      sessionId: input.sessionId,
      activeVariantId: variants.length > 0 ? variants[0].id : null,
      variants,
      status: workspaceStatus,
      summary: this.buildWorkspaceSummary(variants, critiques),
      updatedAt: new Date().toISOString(),
    };

    const assistantMessage = this.buildAssistantMessage(input, variants, critiques);
    const timeline = this.buildTimeline(input, artifacts);

    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      assistantMessage,
      timeline,
      workspace,
      nextActions: this.buildTopLevelActions(variants),
      raw: {
        artifactIds: artifacts.map((a) => a.id),
        evidenceChainIds: evidenceChains.map((ec) => ec.id),
        critiqueItemIds: critiques.map((c) => c.artifactId).filter(Boolean) as string[],
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
    const status = mapEnhancementToStatus(enhancementStatus);

    // Badges
    const badges: ProductVariant["badges"] = [];
    if (status === "ready") badges.push({ label: "Ready to use", tone: "positive" });
    else if (status === "needs_confirmation") badges.push({ label: "Needs confirmation", tone: "warning" });
    else if (status === "unsafe") badges.push({ label: "Unsafe", tone: "danger" });
    else if (status === "accepted") badges.push({ label: "Accepted", tone: "positive" });
    else if (status === "rejected") badges.push({ label: "Rejected", tone: "danger" });

    if (critique) {
      if (critique.verdict === "pass") badges.push({ label: "Vetted", tone: "positive" });
      else if (critique.verdict === "revise") badges.push({ label: "Needs revision", tone: "warning" });
      else if (critique.verdict === "reject") badges.push({ label: "Not recommended", tone: "danger" });
    }

    // Score
    const score: ProductVariant["score"] = {
      overall: artifact.scores?.overall,
      relevance: artifact.scores?.requirementMatch,
      evidenceStrength: artifact.scores?.evidenceStrength,
    };

    // Evidence summary (natural language)
    const sourceEvidences = evidence?.sourceEvidences ?? [];
    const evidenceItems = sourceEvidences.map((ev) => ({
      id: ev.id,
      title: ev.excerpt ? truncate(ev.excerpt, 80) : "Evidence item",
      quote: ev.excerpt ?? undefined,
      explanation: ev.sourceRef ?? "Source reference",
      confidence: ev.confidence,
    }));

    const evidenceCoverageLabel = evidenceItems.length > 0
      ? `${evidenceItems.length} evidence sources support this version`
      : "No direct evidence linked";

    // Risk summary (natural language)
    const unsupportedClaims = critique?.unsupportedClaims ?? [];
    const missingEvidence = critique?.missingEvidence ?? [];
    const riskWarnings: string[] = [];
    if (critique?.truthfulnessRisk && critique.truthfulnessRisk !== "low") {
      riskWarnings.push(`Truthfulness risk: ${critique.truthfulnessRisk}`);
    }
    if (critique?.exaggerationRisk && critique.exaggerationRisk !== "low") {
      riskWarnings.push(`Exaggeration risk: ${critique.exaggerationRisk}`);
    }
    const riskLevel = critique?.truthfulnessRisk === "high" || critique?.exaggerationRisk === "high"
      ? "high" : (unsupportedClaims.length > 0 ? "medium" : "low");

    // Missing info (natural language)
    const missingInfo: string[] = [];
    if (critique?.confirmationQuestions) {
      missingInfo.push(...critique.confirmationQuestions);
    }
    for (const claim of (critique?.claimReviews ?? [])) {
      if (claim.supportLevel === "needs_user_confirmation" || claim.supportLevel === "unsupported") {
        missingInfo.push(`"${truncate(claim.claimText ?? "", 60)}" — ${claim.reason ?? "needs verification"}`);
      }
    }

    // Reason (frontend-displayable)
    const reason = this.computeReason(artifact, critique, score, evidenceItems.length, input);

    // Per-variant actions
    const actions = this.buildVariantActions(artifact.id, status);

    // Source IDs
    const sourceExperienceIds = artifact.sourceExperienceIds ?? [];
    const sourceEvidenceIds = artifact.sourceEvidenceIds ?? [];

    // Raw (safe debug data, nothing sensitive)
    const raw: Record<string, unknown> = {
      artifactId: artifact.id,
      critiqueVerdict: critique?.verdict ?? null,
      enhancementStatus: enhancementStatus ?? null,
    };

    return {
      id: artifact.id,
      artifactId: artifact.id,
      title: artifact.content
        ? truncate(artifact.content.replace(/\s+/g, " ").trim(), 80)
        : "Untitled",
      content: artifact.content ?? "",
      role: "alternative",
      status,
      score,
      badges,
      reason,
      evidenceSummary: {
        coverageLabel: evidenceCoverageLabel,
        items: evidenceItems,
      },
      riskSummary: {
        level: riskLevel,
        unsupportedClaims,
        missingEvidence,
        warnings: riskWarnings,
      },
      missingInfo,
      sourceExperienceIds,
      sourceEvidenceIds,
      actions,
      raw,
      createdAt: artifact.createdAt ?? new Date().toISOString(),
      after: artifact.content ?? "",
    };
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
          type: "message_received",
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
      raw: { artifactIds: [], evidenceChainIds: [], critiqueItemIds: [], decisionIds: [] },
    };
  }

  public buildExplainChoice(input: {
    sessionId: string;
    turnId: string;
    variantId: string;
    reason: string;
    workspace: CopilotWorkspace;
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
        content: input.reason,
        kind: "decision_summary",
        createdAt: now,
      },
      timeline: [
        {
          id: `tl-${input.turnId}-1`,
          type: "evidence_opened",
          title: "Choice explanation",
          description: input.reason,
          status: "completed",
          createdAt: now,
          relatedVariantId: input.variantId,
        },
      ],
      workspace: input.workspace,
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
    evidenceItems: ProductVariant["evidenceSummary"]["items"];
    workspace: CopilotWorkspace;
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
      timeline: [
        {
          id: `tl-${input.turnId}-1`,
          type: "evidence_opened",
          title: "Evidence details",
          description: `Showing ${input.evidenceItems.length} evidence sources`,
          status: "completed",
          createdAt: now,
          relatedVariantId: input.variantId,
        },
      ],
      workspace: input.workspace,
      nextActions: [],
      raw: {
        artifactIds: [input.variantId],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
      },
    };
  }

  public buildTimeline(
    input: BuildChatResponseInput,
    artifacts: GeneratedArtifact[],
  ): ProductTimelineItem[] {
    const now = new Date().toISOString();
    const items: ProductTimelineItem[] = [
      {
        id: `tl-${input.turnId}-1`,
        type: "message_received",
        title: "Message received",
        status: "completed",
        createdAt: now,
      },
    ];

    if (artifacts.length > 0) {
      items.push({
        id: `tl-${input.turnId}-2`,
        type: "variants_generated",
        title: `${artifacts.length} variants generated`,
        description: `Generated ${artifacts.length} candidate rewrites.`,
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
        description: "Each variant reviewed for accuracy and evidence support.",
        status: "completed",
        createdAt: now,
      });
    }

    return items;
  }

  // ── Private helpers ──

  private markRecommended(variants: ProductVariant[], bestScore: number): void {
    if (variants.length === 0) return;
    // Sort by score descending, then find first that is ready/needs_confirmation (not unsafe)
    const sorted = [...variants].sort((a, b) => (b.score.overall ?? 0) - (a.score.overall ?? 0));
    const recommended = sorted.find((v) => v.status !== "unsafe") ?? sorted[0];
    recommended.role = "recommended";
    recommended.badges.unshift({ label: "Recommended", tone: "positive" });
    recommended.reason = this.computeRecommendReason(recommended);
    // Mark others
    for (const v of variants) {
      if (v.id !== recommended.id && v.role === "alternative") {
        // keep as alternative
      }
    }
  }

  private computeRecommendReason(variant: ProductVariant): string {
    const parts: string[] = [];
    if (variant.score.overall !== undefined) {
      parts.push(`strongest overall match (${Math.round(variant.score.overall * 100)}%)`);
    }
    if (variant.evidenceSummary.items.length > 0) {
      parts.push(`backed by ${variant.evidenceSummary.items.length} evidence sources`);
    }
    if (variant.riskSummary.level === "low") {
      parts.push("low risk profile");
    }
    return parts.length > 0
      ? `Recommended because: ${parts.join(", ")}.`
      : "Recommended based on overall fit.";
  }

  private computeReason(
    artifact: GeneratedArtifact,
    critique: ArtifactCritiqueItem | undefined,
    score: ProductVariant["score"],
    evidenceCount: number,
    _input: BuildVariantInput,
  ): string {
    const parts: string[] = [];
    if (score.overall !== undefined) {
      parts.push(`match score ${Math.round(score.overall * 100)}%`);
    }
    if (evidenceCount > 0) {
      parts.push(`${evidenceCount} evidence sources`);
    }
    if (critique?.verdict === "pass") parts.push("passed critique");
    else if (critique?.verdict === "revise") parts.push("needs revision");
    return parts.length > 0 ? parts.join(", ") + "." : "Generated from available experience.";
  }

  private buildTopLevelActions(variants: ProductVariant[]): ProductAction[] {
    const recommended = variants.find((v) => v.role === "recommended") ?? variants[0];
    if (!recommended) return [];

    const criticalTypes: ProductActionType[] = recommended.status === "needs_confirmation"
      ? ["confirm_metric", "accept", "show_evidence", "explain_choice", "revise_more_conservative"]
      : ["accept", "show_evidence", "explain_choice", "revise_more_conservative"];

    return criticalTypes
      .map((type) => recommended.actions.find((action) => action.type === type))
      .filter((action): action is ProductAction => Boolean(action))
      .map((action) => ({
        ...action,
        primary: recommended.status === "needs_confirmation"
          ? action.type === "confirm_metric"
          : action.type === "accept",
      }));
  }

  private buildVariantActions(variantId: string, status: string): ProductAction[] {
    const actions: ProductAction[] = [
      { id: `accept-${variantId}`, type: "accept", label: "Accept", variantId, primary: status !== "needs_confirmation" },
      { id: `reject-${variantId}`, type: "reject", label: "Reject", variantId, primary: false },
      { id: `prefer-${variantId}`, type: "prefer", label: "Prefer this version", variantId, primary: false },
      { id: `conservative-${variantId}`, type: "revise_more_conservative", label: "More conservative", variantId, primary: false },
      { id: `quantified-${variantId}`, type: "revise_more_quantified", label: "More quantified", variantId, primary: false },
      { id: `evidence-${variantId}`, type: "show_evidence", label: "Show evidence", variantId, primary: false },
      { id: `explain-${variantId}`, type: "explain_choice", label: "Why this version?", variantId, primary: false },
    ];
    if (status === "needs_confirmation") {
      actions.splice(3, 0, {
        id: `confirm-metric-${variantId}`,
        type: "confirm_metric",
        label: "Confirm a metric",
        variantId,
        primary: true,
        inputSchema: {
          fields: [
            { key: "metric", label: "Metric name", type: "text", placeholder: "e.g. bundle size reduction", required: true },
            { key: "value", label: "Value", type: "text", placeholder: "e.g. 40%", required: true },
            { key: "explanation", label: "Explanation", type: "textarea", placeholder: "How do you know this?", required: false },
          ],
        },
      });
    }
    return actions;
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
      return "I've analyzed your input but wasn't able to generate variants yet. Could you provide more context?";
    }
    const recommended = variants.find((v) => v.role === "recommended");
    const passCount = critiques.filter((c) => c.verdict === "pass").length;
    const parts: string[] = [
      `I've generated ${variants.length} candidate rewrites for ${input.targetRole ?? "your target role"}.`,
    ];
    if (recommended) {
      parts.push(`"${recommended.title}" is the recommended version.`);
    }
    if (critiques.length > 0) {
      parts.push(`${passCount} passed critique.`);
    }
    parts.push("Review each version and accept, reject, or request changes.");
    return parts.join(" ");
  }

  private buildWorkspaceSummary(variants: ProductVariant[], critiques: ArtifactCritiqueItem[]): string | undefined {
    if (variants.length === 0) return undefined;
    const passCount = critiques.filter((c) => c.verdict === "pass").length;
    const recommended = variants.find((v) => v.role === "recommended");
    return recommended
      ? `${variants.length} variants · ${passCount} vetted · recommended: "${recommended.title}"`
      : `${variants.length} variants, ${passCount} vetted`;
  }

  private resolveWorkspaceStatus(variants: ProductVariant[]): CopilotWorkspace["status"] {
    if (variants.length === 0) return "empty";
    const hasNeedsConfirmation = variants.some((v) => v.status === "needs_confirmation");
    if (hasNeedsConfirmation) return "awaiting_user_decision";
    return "ready";
  }
}

// ── Helpers ──

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

function mapEnhancementToStatus(enhancementStatus: string | undefined): ProductVariant["status"] {
  if (enhancementStatus === "ready") return "ready";
  if (enhancementStatus === "needs_confirmation") return "needs_confirmation";
  if (enhancementStatus === "unsafe") return "unsafe";
  return "needs_confirmation"; // default: be safe
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
